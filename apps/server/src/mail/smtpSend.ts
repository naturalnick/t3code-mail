import * as Nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS (465). Otherwise STARTTLS is required, never plain text. */
  readonly secure: boolean;
  readonly user: string;
  readonly password: string;
}

export interface OutgoingMessage {
  readonly from: { readonly name: string; readonly address: string };
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string;
  readonly text: string;
  readonly html?: string | null;
  readonly attachments?: ReadonlyArray<{
    readonly filename: string;
    readonly contentType: string;
    readonly content: Buffer;
    readonly cid?: string;
  }>;
  readonly messageId: string;
  readonly inReplyTo: string | null;
  readonly references: ReadonlyArray<string>;
}

const isLocal = (host: string) => host === "127.0.0.1" || host === "localhost";

/** Builds the RFC 5322 message once, so the copy appended to Sent is exactly what was sent. */
export async function buildRaw(message: OutgoingMessage): Promise<Buffer> {
  const composer = new MailComposer({
    from: { name: message.from.name, address: message.from.address },
    to: [...message.to],
    cc: message.cc.length > 0 ? [...message.cc] : undefined,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    ...(message.attachments && message.attachments.length > 0
      ? {
          attachments: message.attachments.map((file) => ({
            filename: file.filename,
            contentType: file.contentType,
            content: file.content,
            ...(file.cid ? { cid: file.cid } : {}),
          })),
        }
      : {}),
    messageId: message.messageId,
    inReplyTo: message.inReplyTo ?? undefined,
    references: message.references.length > 0 ? [...message.references] : undefined,
  });
  return composer.compile().build();
}

export async function sendRaw(config: SmtpConfig, message: OutgoingMessage, raw: Buffer) {
  const transport = Nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure && !isLocal(config.host),
    auth: { user: config.user, pass: config.password },
    tls: { rejectUnauthorized: !isLocal(config.host) },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
  try {
    const result = await transport.sendMail({
      envelope: { from: message.from.address, to: [...message.to, ...message.cc] },
      raw,
    });
    const addressOf = (entry: string | { address: string }) =>
      typeof entry === "string" ? entry : entry.address;
    return { accepted: result.accepted.map(addressOf), rejected: result.rejected.map(addressOf) };
  } finally {
    transport.close();
  }
}

/** Failures that happen before the server could have accepted the message. */
const DEFINITE_CODES = new Set(["EAUTH", "ENOAUTH", "ECONNECTION", "EDNS", "ETLS", "EENVELOPE"]);

export function classifySmtpError(error: unknown): {
  readonly auth: boolean;
  /** False when the connection broke mid-send, so the message may have gone out. */
  readonly definite: boolean;
  readonly detail: string;
} {
  const record = (error ?? {}) as Record<string, unknown>;
  const detail =
    (typeof record.response === "string" && record.response) ||
    (typeof record.message === "string" && record.message) ||
    "The mail server refused the message.";
  return {
    auth: record.code === "EAUTH" || record.responseCode === 535,
    definite:
      typeof record.responseCode === "number" ||
      (typeof record.code === "string" && DEFINITE_CODES.has(record.code)),
    detail,
  };
}
