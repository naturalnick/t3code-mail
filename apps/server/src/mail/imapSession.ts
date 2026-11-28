// @effect-diagnostics globalDate:off -- imapflow hands envelope dates over as JS Dates.
// @effect-diagnostics globalTimers:off -- the IDLE refresh timer lives inside imapflow's promise flow.
// The IMAP adapter: imapflow is promise and event based, so this module stays plain async code
// and MailSync drives it from Effect. Nothing here touches the mail store.
import * as Schema from "effect/Schema";
import type { MailAddress, MailAttachment } from "@t3tools/contracts";
import {
  ImapFlow,
  type FetchMessageObject,
  type ListResponse,
  type MessageAddressObject,
  type MessageStructureObject,
} from "imapflow";

import { htmlToText, normalizeWhitespace } from "./mailText.ts";

export interface ImapConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly password: string;
}

export const ImapFailureKind = Schema.Literals(["auth", "quota", "network", "other"]);
export type ImapFailureKind = typeof ImapFailureKind.Type;

export class ImapFailure extends Schema.TaggedError<ImapFailure>()("ImapFailure", {
  kind: ImapFailureKind,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

/** Sorts imapflow errors into what the user must do: re-enter a password, wait, or nothing. */
const isImapFailure = Schema.is(ImapFailure);

export function classifyImapError(error: unknown): ImapFailure {
  if (isImapFailure(error)) return error;
  const record = (error ?? {}) as Record<string, unknown>;
  const text = [record.responseText, record.message, record.serverResponseCode, record.code]
    .filter((value) => typeof value === "string")
    .join(" ");
  const detail =
    (typeof record.responseText === "string" && record.responseText) ||
    (typeof record.message === "string" && record.message) ||
    "The mail server did not respond.";
  if (
    record.authenticationFailed === true ||
    /AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|Invalid credentials|LOGIN failed|authentication failed|Application-specific password required|web login required/i.test(
      text,
    )
  ) {
    return new ImapFailure({ kind: "auth", detail, cause: error });
  }
  if (
    /OVERQUOTA|bandwidth|download limit|exceeded|too many simultaneous|THROTTLED|LIMIT/i.test(text)
  ) {
    return new ImapFailure({ kind: "quota", detail, cause: error });
  }
  if (
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|socket|timeout|NoConnection|closed/i.test(
      text,
    )
  ) {
    return new ImapFailure({ kind: "network", detail, cause: error });
  }
  return new ImapFailure({ kind: "other", detail, cause: error });
}

export interface ParsedMessage {
  readonly deliveredAt?: number;
  readonly uid: number;
  readonly messageId: string | null;
  readonly gmailThreadId: string | null;
  readonly labels: ReadonlyArray<string> | null;
  readonly from: MailAddress;
  /** Where the sender asks replies to go; IMAP reports the sender here when there is none. */
  readonly replyTo: ReadonlyArray<MailAddress>;
  readonly to: ReadonlyArray<MailAddress>;
  readonly cc: ReadonlyArray<MailAddress>;
  readonly bcc?: ReadonlyArray<MailAddress> | undefined;
  readonly subject: string;
  readonly date: string;
  readonly inReplyTo: string | null;
  readonly references: ReadonlyArray<string>;
  readonly seen: boolean;
  readonly size: number;
  readonly attachments: ReadonlyArray<MailAttachment>;
  readonly textPart: { readonly part: string; readonly html: boolean } | null;
  readonly listUnsubscribe: boolean;
  readonly listId: string | null;
  readonly precedence: string | null;
  readonly autoSubmitted: string | null;
  readonly calendar: boolean;
}

export interface MailboxSnapshot {
  readonly uidValidity: string;
  readonly uidNext: number;
  readonly exists: number;
  readonly highestModseq: string | null;
}

export interface FlagChange {
  readonly uid: number;
  readonly seen: boolean;
  readonly labels: ReadonlyArray<string> | null;
}

export interface MailboxRoles {
  readonly gmail: boolean;
  /** Gmail: All Mail. Others: INBOX. Synced and watched with IDLE. */
  readonly primary: string;
  /** Sent mail, polled; null for Gmail, where All Mail already holds it. */
  readonly sent: string | null;
  readonly archive: string | null;
  readonly trash: string | null;
  readonly junk: string | null;
}

const HEADER_FIELDS = ["references", "list-unsubscribe", "list-id", "precedence", "auto-submitted"];
const FETCH_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  bodyStructure: true,
  size: true,
  internalDate: true,
  threadId: true,
  labels: true,
  headers: HEADER_FIELDS,
} as const;
const BODY_MAX_BYTES = 256 * 1024;
const BODY_MAX_CHARS = 100_000;

function parseHeaders(buffer: Buffer | undefined): Map<string, string> {
  const headers = new Map<string, string>();
  if (!buffer) return headers;
  const unfolded = buffer.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(key, headers.has(key) ? `${headers.get(key)} ${value}` : value);
  }
  return headers;
}

const toAddress = (value: MessageAddressObject | undefined): MailAddress => ({
  name: value?.name?.trim() ?? "",
  address: (value?.address ?? "").trim().toLowerCase(),
});

const messageIdsIn = (value: string | undefined): ReadonlyArray<string> =>
  value ? [...value.matchAll(/<[^<>\s]+>/g)].map((match) => match[0]) : [];

function walkStructure(
  node: MessageStructureObject | undefined,
  visit: (node: MessageStructureObject, part: string) => void,
  path = "",
) {
  if (!node) return;
  if (node.disposition === "attachment" || node.type.toLowerCase() === "message/rfc822") {
    visit(node, node.part ?? (path || "1"));
    return;
  }
  const children = node.childNodes ?? [];
  if (children.length === 0) {
    visit(node, node.part ?? (path || "1"));
    return;
  }
  children.forEach((child, index) =>
    walkStructure(child, visit, child.part ?? (path ? `${path}.${index + 1}` : String(index + 1))),
  );
}

function describeStructure(structure: MessageStructureObject | undefined) {
  const parts: Array<{ part: string; file: MailAttachment; cid?: string }> = [];
  let plain: string | null = null;
  let html: string | null = null;
  let calendar = false;
  walkStructure(structure, (node, part) => {
    const type = node.type.toLowerCase();
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
    if (type === "text/calendar") calendar = true;
    const isAttachment =
      node.disposition === "attachment" || (filename !== null && !type.startsWith("text/"));
    if (isAttachment) {
      const cid = node.id?.replace(/^<|>$/g, "");
      parts.push({
        part,
        file: { filename: filename ?? "attachment", contentType: type, size: node.size ?? 0 },
        ...(cid ? { cid } : {}),
      });
      return;
    }
    if (type === "text/plain" && plain === null) plain = part;
    else if (type === "text/html" && html === null) html = part;
  });
  const textPart =
    plain !== null
      ? { part: plain, html: false }
      : html !== null
        ? { part: html, html: true }
        : null;
  return { parts, textPart, calendar };
}

function isKeyword(flag: string) {
  return (
    /^[\x21-\x7e]+$/.test(flag) &&
    !/[(){}%*"\\\]]/.test(flag) &&
    !/^(?:junk|nonjunk|\$(?:junk|notjunk|forwarded|mdnsent|phishing|mailflagbit\d+|hasattachment|hasnoattachment))$/i.test(
      flag,
    )
  );
}

function messageLabels(message: FetchMessageObject, gmail: boolean) {
  if (gmail) return message.labels ? [...message.labels] : null;
  return message.flags
    ? [...message.flags].filter(isKeyword).map((name) => name.toLowerCase())
    : null;
}

function parseFetched(message: FetchMessageObject, labels: ParsedMessage["labels"]): ParsedMessage {
  const envelope = message.envelope ?? {};
  const headers = parseHeaders(message.headers);
  const structure = describeStructure(message.bodyStructure);
  const rawDate = envelope.date ?? message.internalDate;
  const date = rawDate ? new Date(rawDate) : new Date(0);
  const references = messageIdsIn(headers.get("references"));
  return {
    uid: message.uid,
    messageId: envelope.messageId?.trim() || null,
    ...(message.internalDate ? { deliveredAt: new Date(message.internalDate).getTime() } : {}),
    gmailThreadId: message.threadId ?? null,
    labels,
    from: toAddress(envelope.from?.[0] ?? envelope.sender?.[0]),
    replyTo: (envelope.replyTo ?? []).map(toAddress),
    to: (envelope.to ?? []).map(toAddress),
    cc: (envelope.cc ?? []).map(toAddress),
    bcc: (envelope.bcc ?? []).map(toAddress),
    subject: envelope.subject?.trim() ?? "",
    date: Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString(),
    inReplyTo: messageIdsIn(envelope.inReplyTo)[0] ?? null,
    references,
    seen: message.flags?.has("\\Seen") ?? false,
    size: message.size ?? 0,
    attachments: structure.parts.map(({ file }) => file),
    textPart: structure.textPart,
    listUnsubscribe: headers.has("list-unsubscribe"),
    listId: headers.get("list-id") ?? null,
    precedence: headers.get("precedence") ?? null,
    autoSubmitted:
      headers.get("auto-submitted") && headers.get("auto-submitted") !== "no"
        ? (headers.get("auto-submitted") ?? null)
        : null,
    calendar: structure.calendar,
  };
}

function pickRoles(mailboxes: ReadonlyArray<ListResponse>, gmail: boolean): MailboxRoles {
  const byUse = (use: string) => mailboxes.find((box) => box.specialUse === use)?.path ?? null;
  const byName = (pattern: RegExp) => mailboxes.find((box) => pattern.test(box.path))?.path ?? null;
  if (gmail) {
    return {
      gmail,
      primary: byUse("\\All") ?? byName(/^\[Gmail\]\/All Mail$/i) ?? "INBOX",
      sent: null,
      archive: null,
      trash: byUse("\\Trash") ?? byName(/^\[Gmail\]\/(Trash|Bin)$/i),
      junk: byUse("\\Junk") ?? byName(/^\[Gmail\]\/Spam$/i),
    };
  }
  return {
    gmail,
    primary: mailboxes.find((box) => box.path.toUpperCase() === "INBOX")?.path ?? "INBOX",
    sent: byUse("\\Sent") ?? byName(/^(INBOX[./])?Sent( Items| Messages| Mail)?$/i),
    archive: byUse("\\Archive") ?? byName(/^(INBOX[./])?Archive$/i),
    trash: byUse("\\Trash") ?? byName(/^(INBOX[./])?(Trash|Deleted( Items| Messages)?)$/i),
    junk: byUse("\\Junk") ?? byName(/^(INBOX[./])?(Junk|Spam|Junk E-?mail|Bulk Mail)$/i),
  };
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const isLoopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "::1";

/** App passwords never cross the network in the clear: without implicit TLS, STARTTLS is required. */
const transportSecurity = (config: ImapConfig) => ({
  ...(config.secure || isLoopback(config.host) ? {} : { doSTARTTLS: true }),
  tls: { rejectUnauthorized: !isLoopback(config.host) },
});

export interface SessionEvents {
  readonly onExists: () => void;
  readonly onFlags: (change: { uid: number | undefined; seq: number }) => void;
  readonly onExpunge: (path: string, uid: number | undefined) => void;
  readonly onClose: () => void;
}

export class ImapSession {
  readonly client: ImapFlow;
  roles: MailboxRoles | null = null;
  customPaths: string[] = [];
  readonly keywords = new Set<string>();
  /** Set once we have asked imapflow to enable QRESYNC and the server agreed. */
  qresync = false;

  constructor(config: ImapConfig, events: SessionEvents) {
    this.client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
      qresync: true,
      clientInfo: { name: "Code + Mailbox" },
      ...transportSecurity(config),
    });
    this.client.on("exists", () => events.onExists());
    this.client.on("flags", (data) => events.onFlags({ uid: data.uid, seq: data.seq }));
    this.client.on("expunge", (data) =>
      events.onExpunge(data.path, data.vanished || this.qresync ? data.uid : undefined),
    );
    this.client.on("close", () => events.onClose());
    // imapflow emits at most one error per connection and closes after it; close drives reconnects.
    this.client.on("error", () => {});
  }

  get gmail(): boolean {
    return this.client.capabilities.has("X-GM-EXT-1");
  }

  get condstore(): boolean {
    return this.client.capabilities.has("CONDSTORE") || this.client.capabilities.has("QRESYNC");
  }

  get supportsIdle(): boolean {
    return this.client.capabilities.has("IDLE");
  }

  async connect(): Promise<MailboxRoles> {
    try {
      await this.client.connect();
      this.qresync = this.client.enabled.has("QRESYNC");
      return await this.refreshPaths();
    } catch (error) {
      throw classifyImapError(error);
    }
  }

  private labelsOf(message: FetchMessageObject) {
    const labels = messageLabels(message, this.gmail);
    if (!this.gmail && labels) for (const label of labels) this.keywords.add(label);
    return labels;
  }

  async refreshPaths() {
    const mailboxes = await this.client.list();
    const roles = pickRoles(mailboxes, this.gmail);
    this.roles = roles;
    const reserved = [roles.primary, roles.sent, roles.archive, roles.trash, roles.junk];
    this.customPaths = mailboxes
      .filter(
        (box) =>
          !box.specialUse &&
          !box.path.startsWith("\\") &&
          !box.flags.has("\\Noselect") &&
          box.path.toUpperCase() !== "INBOX" &&
          !reserved.includes(box.path) &&
          (this.gmail || !/^(?:INBOX[./])?(?:Drafts|Junk|Spam|Outbox)$/i.test(box.path)),
      )
      .map((box) => box.path)
      .sort();
    return roles;
  }

  /** Selects a mailbox for a unit of work, handing QRESYNC our last known state. */
  async withMailbox<A>(
    path: string,
    known: { readonly uidValidity: string; readonly highestModseq: string | null } | null,
    work: (snapshot: MailboxSnapshot) => Promise<A>,
  ): Promise<A> {
    let lock;
    try {
      lock = await this.client.getMailboxLock(
        path,
        this.qresync && known?.highestModseq
          ? { changedSince: known.highestModseq, uidValidity: known.uidValidity }
          : {},
      );
    } catch (error) {
      throw classifyImapError(error);
    }
    try {
      const mailbox = this.client.mailbox;
      if (!mailbox) {
        throw new ImapFailure({
          kind: "other",
          detail: "The mailbox closed while it was being read.",
        });
      }
      if (!this.gmail)
        for (const flag of [...mailbox.flags, ...(mailbox.permanentFlags ?? [])]) {
          if (isKeyword(flag)) this.keywords.add(flag.toLowerCase());
        }
      return await work({
        uidValidity: String(mailbox.uidValidity),
        uidNext: mailbox.uidNext,
        exists: mailbox.exists,
        highestModseq: mailbox.highestModseq === undefined ? null : String(mailbox.highestModseq),
      });
    } catch (error) {
      throw classifyImapError(error);
    } finally {
      lock.release();
    }
  }

  /** Messages with UID above `afterUid`, oldest first, at most `limit`. */
  /** The oldest `limit` messages above `afterUid`, so the cursor never skips one. */
  async fetchNewer(afterUid: number, limit: number): Promise<ReadonlyArray<ParsedMessage>> {
    const found = await this.client.search({ uid: `${afterUid + 1}:*` }, { uid: true });
    // `n:*` always matches the newest message, even when its UID is below n.
    const uids = [...(found || [])].filter((uid) => uid > afterUid).sort((a, b) => a - b);
    return this.fetchUids(uids.slice(0, limit));
  }

  async fetchUids(uids: ReadonlyArray<number>): Promise<ReadonlyArray<ParsedMessage>> {
    if (uids.length === 0) return [];
    const messages: Array<ParsedMessage> = [];
    for await (const message of this.client.fetch(uids.join(","), FETCH_QUERY, { uid: true })) {
      messages.push(parseFetched(message, this.labelsOf(message)));
    }
    return messages.sort((a, b) => a.uid - b.uid);
  }

  /** The newest `count` messages by sequence number: the recent-first start of a sync. */
  async fetchNewest(exists: number, count: number): Promise<ReadonlyArray<ParsedMessage>> {
    if (exists === 0) return [];
    const from = Math.max(1, exists - count + 1);
    const messages: Array<ParsedMessage> = [];
    for await (const message of this.client.fetch(`${from}:*`, FETCH_QUERY)) {
      messages.push(parseFetched(message, this.labelsOf(message)));
    }
    return messages.sort((a, b) => a.uid - b.uid);
  }

  /** The next older page below `belowUid`, for the slow backfill. */
  async fetchOlder(belowUid: number, count: number): Promise<ReadonlyArray<ParsedMessage>> {
    if (belowUid <= 1) return [];
    const uids = await this.client.search({ uid: `1:${belowUid - 1}` }, { uid: true });
    if (!uids || uids.length === 0) return [];
    return this.fetchUids([...uids].sort((a, b) => a - b).slice(-count));
  }

  /** Flag and label changes: CONDSTORE since a modseq, else a re-read of the recent window. */
  async fetchFlagChanges(input: {
    readonly sinceModseq: string | null;
    readonly windowFromUid: number;
  }): Promise<ReadonlyArray<FlagChange>> {
    if (input.sinceModseq !== null && this.condstore)
      return this.readFlags("1:*", BigInt(input.sinceModseq));
    return this.readFlags(`${Math.max(1, input.windowFromUid)}:*`);
  }

  async readFlags(range: string, changedSince?: bigint): Promise<FlagChange[]> {
    const changes: FlagChange[] = [];
    for await (const message of this.client.fetch(
      range,
      { uid: true, flags: true, labels: true },
      { uid: true, ...(changedSince === undefined ? {} : { changedSince }) },
    )) {
      changes.push({
        uid: message.uid,
        seen: message.flags?.has("\\Seen") ?? false,
        labels: this.labelsOf(message),
      });
    }
    return changes;
  }

  async allUids(fromUid: number): Promise<ReadonlySet<number>> {
    const uids = await this.client.search({ uid: `${Math.max(1, fromUid)}:*` }, { uid: true });
    return new Set(uids || []);
  }

  async fetchBody(
    uid: number,
    part: { readonly part: string; readonly html: boolean },
  ): Promise<string | null> {
    const download = await this.client.download(String(uid), part.part, {
      uid: true,
      maxBytes: BODY_MAX_BYTES,
    });
    if (!download.content) return null;
    const raw = (await streamToBuffer(download.content)).toString("utf8");
    const text = part.html ? htmlToText(raw) : normalizeWhitespace(raw);
    return text.length > BODY_MAX_CHARS ? text.slice(0, BODY_MAX_CHARS) : text;
  }

  async fetchFormattedBody(uid: number) {
    const message = await this.client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
    if (!message || !message.bodyStructure) throw new Error("Message structure unavailable");
    let htmlPart = "";
    const images: Array<{ cid: string; part: string; type: string; size: number }> = [];
    walkStructure(message.bodyStructure, (node, part) => {
      if (node.disposition === "attachment") return;
      const type = node.type.toLowerCase();
      if (!htmlPart && type === "text/html") htmlPart = part;
      if (node.id && node.size && /^image\/(png|jpeg|gif|webp)$/i.test(type)) {
        images.push({ cid: node.id.replace(/^<|>$/g, ""), part, type, size: node.size });
      }
    });
    if (!htmlPart) return null;
    const body = await this.client.download(String(uid), htmlPart, {
      uid: true,
      maxBytes: 512 * 1024,
    });
    if (!body.content) throw new Error("Message body unavailable");
    const html = (await streamToBuffer(body.content)).toString("utf8");
    const inlineImages: Record<string, string> = Object.create(null);
    let remaining = BODY_MAX_BYTES;
    for (const image of images.slice(0, 16)) {
      if (image.size > remaining || !html.includes(`cid:${image.cid}`)) continue;
      const download = await this.client.download(String(uid), image.part, {
        uid: true,
        maxBytes: remaining,
      });
      if (download.content) {
        const bytes = await streamToBuffer(download.content);
        inlineImages[image.cid] = `data:${image.type};base64,${bytes.toString("base64")}`;
        remaining -= bytes.length;
      }
    }
    return { html, inlineImages };
  }

  /** Reply-To for messages synced before it was recorded. */
  async fetchReplyTo(
    uids: ReadonlyArray<number>,
  ): Promise<ReadonlyArray<{ uid: number; replyTo: ReadonlyArray<MailAddress> }>> {
    if (uids.length === 0) return [];
    const found: Array<{ uid: number; replyTo: ReadonlyArray<MailAddress> }> = [];
    for await (const message of this.client.fetch(
      uids.join(","),
      { envelope: true },
      { uid: true },
    ))
      found.push({ uid: message.uid, replyTo: (message.envelope?.replyTo ?? []).map(toAddress) });
    return found;
  }

  /**
   * Reads the selected attachment, or all attachments for a forward, within a decoded byte budget.
   * Inline parts keep their Content-ID so forwarded HTML still shows them.
   */
  async fetchAttachments(uid: number, maxBytes: number, index?: number) {
    const message = await this.client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
    if (!message || !message.bodyStructure) throw new Error("Message structure unavailable");
    const { parts } = describeStructure(message.bodyStructure);
    const selected = index === undefined ? parts : parts.slice(index, index + 1);
    const files: Array<{ filename: string; contentType: string; content: Buffer; cid?: string }> =
      [];
    let remaining = maxBytes;
    for (const { part, file, cid } of selected) {
      const download = await this.client.download(String(uid), part, { uid: true });
      if (!download.content) throw new Error("Attachment unavailable");
      const chunks: Array<Buffer> = [];
      // Structure sizes are transfer-encoded, so the budget counts the decoded bytes as they arrive.
      for await (const chunk of download.content) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        remaining -= buffer.length;
        if (remaining < 0) {
          download.content.destroy?.();
          return { files, complete: false };
        }
        chunks.push(buffer);
      }
      files.push({
        filename: file.filename,
        contentType: file.contentType,
        ...(cid ? { cid } : {}),
        content: Buffer.concat(chunks),
      });
    }
    return { files, complete: true };
  }

  /** Only download the signed source when one-click is offered and the message fits the limit. */
  async fetchUnsubscribeSource(uid: number, maxBytes: number): Promise<Buffer | null> {
    const summary = await this.client.fetchOne(
      String(uid),
      { size: true, headers: ["from", "list-unsubscribe", "list-unsubscribe-post"] },
      { uid: true },
    );
    if (!summary || !summary.headers) return null;
    if (
      summary.size === undefined ||
      summary.size > maxBytes ||
      !/^list-unsubscribe-post:/im.test(summary.headers.toString("latin1"))
    )
      return summary.headers;
    const message = await this.client.fetchOne(
      String(uid),
      { source: { start: 0, maxLength: maxBytes + 1 } },
      { uid: true },
    );
    return message && message.source && message.source.length <= maxBytes
      ? message.source
      : summary.headers;
  }

  /** Gmail server-side search; returns All Mail UIDs. */
  async searchGmailRaw(query: string): Promise<ReadonlyArray<number>> {
    const uids = await this.client.search({ gmraw: query }, { uid: true });
    return uids || [];
  }

  async setSeen(uids: ReadonlyArray<number>, seen: boolean): Promise<void> {
    if (uids.length === 0) return;
    if (seen)
      await this.client.messageFlagsAdd(uids.join(","), ["\\Seen"], { uid: true, silent: true });
    else
      await this.client.messageFlagsRemove(uids.join(","), ["\\Seen"], { uid: true, silent: true });
  }

  async setLabel(uids: ReadonlyArray<number>, name: string, apply: boolean): Promise<FlagChange[]> {
    const box = this.client.mailbox;
    if (!box || box.readOnly || !uids.length)
      throw new Error("The mailbox is unavailable for label changes.");
    let flag = name;
    if (this.gmail) {
      if (!this.customPaths.includes(name))
        throw new Error("This Gmail label is no longer available.");
    } else {
      if (!isKeyword(name)) throw new Error("Invalid IMAP tag.");
      const permanent = box.permanentFlags;
      const existing = [...(permanent ?? []), ...box.flags].find(
        (item) => item.toLowerCase() === name.toLowerCase(),
      );
      flag = existing ?? name;
      if (permanent && !permanent.has("\\*") && !permanent.has(flag))
        throw new Error("This mailbox does not allow changes to that tag.");
    }
    const range = uids.join(",");
    const options = { uid: true, useLabels: this.gmail };
    const updated = apply
      ? await this.client.messageFlagsAdd(range, [flag], options)
      : await this.client.messageFlagsRemove(range, [flag], options);
    if (!updated) throw new Error("The mail server declined the label change.");
    return this.readFlags(range);
  }

  /** Gmail archive: drop the Inbox label. Undo puts it back. */
  async setInboxLabel(uids: ReadonlyArray<number>, inInbox: boolean): Promise<void> {
    if (uids.length === 0) return;
    if (inInbox) {
      await this.client.messageFlagsAdd(uids.join(","), ["\\Inbox"], {
        uid: true,
        useLabels: true,
      });
    } else {
      await this.client.messageFlagsRemove(uids.join(","), ["\\Inbox"], {
        uid: true,
        useLabels: true,
      });
    }
  }

  /** Moves messages and returns their new UIDs when the server reports them (UIDPLUS). */
  async move(uids: ReadonlyArray<number>, destination: string) {
    if (uids.length === 0) return null;
    const result = await this.client.messageMove(uids.join(","), destination, { uid: true });
    return result && result.uidMap && result.uidValidity !== undefined
      ? { uidMap: result.uidMap, uidValidity: String(result.uidValidity) }
      : null;
  }

  get supportsUidPlus() {
    return this.client.capabilities.has("UIDPLUS") || this.client.capabilities.has("IMAP4REV2");
  }

  /** Like `move`, but a refused MOVE throws instead of passing for one without UIDPLUS. */
  async moveOrThrow(uids: ReadonlyArray<number>, destination: string) {
    const result = await this.client.messageMove(uids.join(","), destination, { uid: true });
    if (!result)
      throw new ImapFailure({
        kind: "other",
        detail: `The server did not move mail to ${destination}.`,
      });
    return result.uidMap && result.uidValidity !== undefined
      ? { uidMap: result.uidMap, uidValidity: String(result.uidValidity) }
      : null;
  }

  /** UIDs in the selected mailbox whose Message-ID header is one of `messageIds`. */
  async searchMessageIds(messageIds: ReadonlyArray<string>): Promise<ReadonlyArray<number>> {
    const found = new Set<number>();
    for (const messageId of messageIds) {
      const uids = await this.client.search({ header: { "message-id": messageId } }, { uid: true });
      for (const uid of uids || []) found.add(uid);
    }
    return [...found];
  }

  async ensureMailbox(path: string): Promise<void> {
    try {
      await this.client.mailboxCreate(path);
    } catch (error) {
      const record = (error ?? {}) as Record<string, unknown>;
      if (
        record.serverResponseCode !== "ALREADYEXISTS" &&
        !/exists/i.test(String(record.responseText ?? ""))
      ) {
        throw classifyImapError(error);
      }
    }
  }

  async append(path: string, raw: Buffer): Promise<void> {
    await this.client.append(path, raw, ["\\Seen"]);
  }

  /**
   * IDLE on the open mailbox until the server reports something or `maxMs` passes.
   * Servers without IDLE get a NOOP after a short wait instead.
   */
  async idle(maxMs: number): Promise<void> {
    if (!this.supportsIdle) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(maxMs, 60_000)));
      await this.client.noop();
      return;
    }
    const timer = setTimeout(() => {
      void this.client.noop().catch(() => {});
    }, maxMs);
    try {
      await this.client.idle();
    } finally {
      clearTimeout(timer);
    }
  }

  get usable(): boolean {
    return this.client.usable;
  }
}

/** Logs in and out once: a cheap check of an app password before it is saved. */
export async function verifyLogin(config: ImapConfig): Promise<{ readonly gmail: boolean }> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    ...transportSecurity(config),
  });
  client.on("error", () => {});
  try {
    await client.connect();
    const gmail = client.capabilities.has("X-GM-EXT-1");
    await client.logout();
    return { gmail };
  } catch (error) {
    client.close();
    throw classifyImapError(error);
  }
}
