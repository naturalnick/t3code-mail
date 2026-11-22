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
    messageId: message.messageId,
    inReplyTo: message.inReplyTo ?? undefined,
    references: message.references.length > 0 ? [...message.references] : undefined,
  });
  return composer.compile().build();
}

export async function sendRaw(
  config: SmtpConfig,
  message: OutgoingMessage,
  raw: Buffer,
): Promise<void> {
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
    await transport.sendMail({
      envelope: { from: message.from.address, to: [...message.to, ...message.cc] },
      raw,
    });
  } finally {
    transport.close();
  }
}

export function classifySmtpError(error: unknown): {
  readonly auth: boolean;
  readonly detail: string;
} {
  const record = (error ?? {}) as Record<string, unknown>;
  const detail =
    (typeof record.response === "string" && record.response) ||
    (typeof record.message === "string" && record.message) ||
    "The mail server refused the message.";
  return { auth: record.code === "EAUTH" || record.responseCode === 535, detail };
}
