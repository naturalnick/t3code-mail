import {
  type MailAccountStatus,
  type MailActionEntry,
  type MailActionKind,
  type MailActor,
  type MailAddress,
  type MailAttachment,
  type MailCategory,
  type MailDraft,
  type MailGuardrail,
  type MailMessage,
  type MailProviderKind,
  type MailSettleReason,
  type MailThreadRow,
  type MailThreadState,
  type MailTrustLevel,
  type MailWorkingReason,
  MailAccountId,
  MailDraftId,
  MailThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ServerConfig from "../config.ts";
import type { TrustRecord, TrustUndo } from "./mailTrust.ts";

// Each entry runs once, in order; `PRAGMA user_version` records how many ran.
const MIGRATIONS: ReadonlyArray<ReadonlyArray<string>> = [
  [
    `CREATE TABLE mail_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE mail_accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      imap_host TEXT NOT NULL,
      imap_port INTEGER NOT NULL,
      imap_tls INTEGER NOT NULL,
      smtp_host TEXT NOT NULL,
      smtp_port INTEGER NOT NULL,
      smtp_tls INTEGER NOT NULL,
      username TEXT NOT NULL,
      credential_store TEXT NOT NULL,
      status TEXT NOT NULL,
      status_detail TEXT,
      last_sync_at TEXT,
      backfill_paused_until TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE mail_mailboxes (
      account_id TEXT NOT NULL,
      path TEXT NOT NULL,
      role TEXT NOT NULL,
      uid_validity TEXT NOT NULL,
      max_uid INTEGER NOT NULL,
      min_uid INTEGER,
      highest_modseq TEXT,
      backfill_done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, path)
    )`,
    `CREATE TABLE mail_messages (
      id INTEGER PRIMARY KEY,
      account_id TEXT NOT NULL,
      mailbox TEXT NOT NULL,
      uid INTEGER NOT NULL,
      message_id TEXT,
      thread_id TEXT NOT NULL,
      labels TEXT,
      in_inbox INTEGER NOT NULL,
      from_name TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_json TEXT NOT NULL,
      cc_json TEXT NOT NULL,
      subject TEXT NOT NULL,
      date TEXT NOT NULL,
      in_reply_to TEXT,
      references_json TEXT NOT NULL,
      seen INTEGER NOT NULL,
      outgoing INTEGER NOT NULL,
      size INTEGER NOT NULL,
      attachments_json TEXT NOT NULL,
      list_unsubscribe INTEGER NOT NULL,
      list_id TEXT,
      precedence TEXT,
      auto_submitted TEXT,
      calendar INTEGER NOT NULL,
      text_part TEXT,
      body TEXT,
      body_state TEXT NOT NULL,
      body_attempts INTEGER NOT NULL DEFAULT 0,
      removed INTEGER NOT NULL DEFAULT 0,
      UNIQUE (account_id, mailbox, uid)
    )`,
    `CREATE INDEX mail_messages_thread ON mail_messages (thread_id, date)`,
    `CREATE INDEX mail_messages_message_id ON mail_messages (account_id, message_id)`,
    `CREATE INDEX mail_messages_body_pending ON mail_messages (account_id, date) WHERE body_state = 'pending'`,
    `CREATE INDEX mail_messages_outgoing_to ON mail_messages (account_id, outgoing)`,
    `CREATE TABLE mail_threads (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      from_name TEXT NOT NULL,
      from_address TEXT NOT NULL,
      line TEXT NOT NULL,
      suggested_action TEXT,
      last_message_at TEXT NOT NULL,
      last_incoming_at TEXT,
      last_outgoing_at TEXT,
      message_count INTEGER NOT NULL,
      incoming_count INTEGER NOT NULL,
      unread INTEGER NOT NULL,
      in_inbox INTEGER NOT NULL,
      state TEXT NOT NULL,
      state_at TEXT NOT NULL,
      pinned_at TEXT,
      working_reason TEXT,
      settled_reason TEXT,
      settled_by TEXT,
      snoozed_until TEXT,
      snooze_on_reply INTEGER NOT NULL DEFAULT 0,
      suggestion_reason TEXT,
      suggestion_confidence REAL,
      category TEXT,
      guardrail TEXT,
      bulk INTEGER NOT NULL DEFAULT 0,
      verdict_json TEXT,
      triage_state TEXT NOT NULL,
      triaged_count INTEGER NOT NULL DEFAULT 0,
      nudge TEXT,
      chat_thread_id TEXT,
      injection INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX mail_threads_state ON mail_threads (state, state_at)`,
    `CREATE INDEX mail_threads_triage ON mail_threads (account_id) WHERE triage_state = 'pending'`,
    `CREATE INDEX mail_threads_from ON mail_threads (from_address, last_message_at)`,
    `CREATE TABLE mail_trust (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      reason TEXT,
      approvals INTEGER NOT NULL,
      rejections INTEGER NOT NULL,
      streak INTEGER NOT NULL,
      trust TEXT NOT NULL,
      explicit INTEGER NOT NULL,
      bulk INTEGER,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE mail_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_label TEXT,
      kind TEXT NOT NULL,
      thread_id TEXT,
      reason TEXT,
      undo_json TEXT,
      undone_at TEXT
    )`,
    `CREATE INDEX mail_actions_thread ON mail_actions (thread_id, id)`,
    `CREATE INDEX mail_actions_actor ON mail_actions (actor, id)`,
    `CREATE TABLE mail_drafts (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      to_json TEXT NOT NULL,
      cc_json TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      origin TEXT NOT NULL,
      original_body TEXT,
      status TEXT NOT NULL,
      error TEXT,
      message_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      sent_at TEXT
    )`,
    `CREATE TABLE mail_contacts (
      account_id TEXT NOT NULL,
      address TEXT NOT NULL,
      PRIMARY KEY (account_id, address)
    )`,
    `CREATE INDEX mail_drafts_thread ON mail_drafts (thread_id)`,
    `CREATE TABLE mail_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      emails INTEGER NOT NULL
    )`,
    `CREATE INDEX mail_usage_at ON mail_usage (at)`,
    `CREATE TABLE mail_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    // Trigram matches any 3+ character substring, so an exact phrase works without a word index.
    `CREATE VIRTUAL TABLE mail_search USING fts5(subject, sender, body, tokenize = 'trigram remove_diacritics 1')`,
  ],
];

const SEARCH_BODY_CHARS = 20_000;

export interface MessageInsert {
  readonly accountId: MailAccountId;
  readonly mailbox: string;
  readonly uid: number;
  readonly messageId: string | null;
  readonly threadId: MailThreadId;
  readonly labels: ReadonlyArray<string> | null;
  readonly inInbox: boolean;
  readonly from: MailAddress;
  readonly to: ReadonlyArray<MailAddress>;
  readonly cc: ReadonlyArray<MailAddress>;
  readonly subject: string;
  readonly date: string;
  readonly inReplyTo: string | null;
  readonly references: ReadonlyArray<string>;
  readonly seen: boolean;
  readonly outgoing: boolean;
  readonly size: number;
  readonly attachments: ReadonlyArray<MailAttachment>;
  readonly listUnsubscribe: boolean;
  readonly listId: string | null;
  readonly precedence: string | null;
  readonly autoSubmitted: string | null;
  readonly calendar: boolean;
  readonly textPart: { readonly part: string; readonly html: boolean } | null;
}

export interface StoredMessage extends MessageInsert {
  readonly id: number;
  readonly body: string | null;
  readonly bodyState: "pending" | "loaded" | "unavailable";
  readonly removed: boolean;
}

export interface AccountRow {
  readonly id: MailAccountId;
  readonly email: string;
  readonly displayName: string;
  readonly provider: MailProviderKind;
  readonly imapHost: string;
  readonly imapPort: number;
  readonly imapTls: boolean;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpTls: boolean;
  readonly username: string;
  readonly credentialStore: "keychain" | "file";
  readonly status: MailAccountStatus;
  readonly statusDetail: string | null;
  readonly lastSyncAt: string | null;
  readonly backfillPausedUntil: string | null;
  readonly createdAt: string;
}

export interface MailboxState {
  readonly accountId: MailAccountId;
  readonly path: string;
  readonly role: string;
  readonly uidValidity: string;
  readonly maxUid: number;
  readonly minUid: number | null;
  readonly highestModseq: string | null;
  readonly backfillDone: boolean;
}

export interface ThreadVerdict {
  readonly decision: "settle" | "keep";
  readonly reason: string;
  readonly confidence: number;
  readonly source: "rule" | "memory" | "model" | "escalated";
}

export interface ThreadRecord {
  readonly id: MailThreadId;
  readonly accountId: MailAccountId;
  readonly subject: string;
  readonly fromName: string;
  readonly fromAddress: string;
  readonly line: string;
  readonly suggestedAction: string | null;
  readonly lastMessageAt: string;
  readonly lastIncomingAt: string | null;
  readonly lastOutgoingAt: string | null;
  readonly messageCount: number;
  readonly incomingCount: number;
  readonly unread: boolean;
  readonly inInbox: boolean;
  readonly state: MailThreadState;
  readonly stateAt: string;
  readonly pinnedAt: string | null;
  readonly workingReason: MailWorkingReason | null;
  readonly settledReason: MailSettleReason | null;
  readonly settledBy: MailActor | null;
  readonly snoozedUntil: string | null;
  readonly snoozeOnReply: boolean;
  readonly suggestionReason: MailSettleReason | null;
  readonly suggestionConfidence: number | null;
  readonly category: MailCategory | null;
  readonly guardrail: MailGuardrail | null;
  readonly bulk: boolean;
  readonly verdict: ThreadVerdict | null;
  readonly triageState: "pending" | "done" | "waiting_model" | "capped";
  readonly triagedCount: number;
  readonly nudge: string | null;
  readonly chatThreadId: string | null;
  readonly injection: boolean;
  readonly createdAt: string;
}

/** The thread columns an action may change, so an undo can put them back. */
export type ThreadStatePatch = Partial<
  Pick<
    ThreadRecord,
    | "state"
    | "stateAt"
    | "pinnedAt"
    | "workingReason"
    | "settledReason"
    | "settledBy"
    | "snoozedUntil"
    | "snoozeOnReply"
    | "suggestionReason"
    | "suggestionConfidence"
    | "nudge"
    | "unread"
  >
>;

export interface ActionRecord {
  readonly id: number;
  readonly at: string;
  readonly actor: MailActor;
  readonly actorLabel: string | null;
  readonly kind: MailActionKind;
  readonly threadId: MailThreadId | null;
  readonly reason: string | null;
  readonly undo: {
    readonly threadPatch?: ThreadStatePatch;
    readonly trust?: TrustUndo;
    /** A draft an agent left; undo discards it unless it was sent. */
    readonly draftId?: MailDraftId;
  } | null;
  readonly undoneAt: string | null;
}

export interface DraftRecord extends MailDraft {
  readonly originalBody: string | null;
  readonly messageId: string | null;
}

type Row = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : String(value ?? ""));
const strOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : str(value);
const bool = (value: unknown): boolean => value === 1 || value === true || value === "1";
const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0));
const toJson = (value: unknown): string => JSON.stringify(value);
const json = <A>(value: unknown, fallback: A): A => {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as A;
  } catch {
    return fallback;
  }
};

const toAccount = (row: Row): AccountRow => ({
  id: MailAccountId.make(str(row.id)),
  email: str(row.email),
  displayName: str(row.display_name),
  provider: str(row.provider) as MailProviderKind,
  imapHost: str(row.imap_host),
  imapPort: num(row.imap_port),
  imapTls: bool(row.imap_tls),
  smtpHost: str(row.smtp_host),
  smtpPort: num(row.smtp_port),
  smtpTls: bool(row.smtp_tls),
  username: str(row.username),
  credentialStore: str(row.credential_store) as "keychain" | "file",
  status: str(row.status) as MailAccountStatus,
  statusDetail: strOrNull(row.status_detail),
  lastSyncAt: strOrNull(row.last_sync_at),
  backfillPausedUntil: strOrNull(row.backfill_paused_until),
  createdAt: str(row.created_at),
});

const toThread = (row: Row): ThreadRecord => ({
  id: MailThreadId.make(str(row.id)),
  accountId: MailAccountId.make(str(row.account_id)),
  subject: str(row.subject),
  fromName: str(row.from_name),
  fromAddress: str(row.from_address),
  line: str(row.line),
  suggestedAction: strOrNull(row.suggested_action),
  lastMessageAt: str(row.last_message_at),
  lastIncomingAt: strOrNull(row.last_incoming_at),
  lastOutgoingAt: strOrNull(row.last_outgoing_at),
  messageCount: num(row.message_count),
  incomingCount: num(row.incoming_count),
  unread: bool(row.unread),
  inInbox: bool(row.in_inbox),
  state: str(row.state) as MailThreadState,
  stateAt: str(row.state_at),
  pinnedAt: strOrNull(row.pinned_at),
  workingReason: strOrNull(row.working_reason) as MailWorkingReason | null,
  settledReason: strOrNull(row.settled_reason) as MailSettleReason | null,
  settledBy: strOrNull(row.settled_by) as MailActor | null,
  snoozedUntil: strOrNull(row.snoozed_until),
  snoozeOnReply: bool(row.snooze_on_reply),
  suggestionReason: strOrNull(row.suggestion_reason) as MailSettleReason | null,
  suggestionConfidence: row.suggestion_confidence === null ? null : num(row.suggestion_confidence),
  category: strOrNull(row.category) as MailCategory | null,
  guardrail: strOrNull(row.guardrail) as MailGuardrail | null,
  bulk: bool(row.bulk),
  verdict: json<ThreadVerdict | null>(row.verdict_json, null),
  triageState: str(row.triage_state) as ThreadRecord["triageState"],
  triagedCount: num(row.triaged_count),
  nudge: strOrNull(row.nudge),
  chatThreadId: strOrNull(row.chat_thread_id),
  injection: bool(row.injection),
  createdAt: str(row.created_at),
});

export function threadRow(thread: ThreadRecord, hasDraft: boolean): MailThreadRow {
  return {
    id: thread.id,
    accountId: thread.accountId,
    subject: thread.subject,
    from: { name: thread.fromName, address: thread.fromAddress },
    line: thread.line,
    suggestedAction: thread.suggestedAction,
    lastMessageAt: thread.lastMessageAt,
    messageCount: thread.messageCount,
    unread: thread.unread,
    state: thread.state,
    stateAt: thread.stateAt,
    pinnedAt: thread.pinnedAt,
    workingReason: thread.state === "working" ? thread.workingReason : null,
    settledReason: thread.state === "settled" ? thread.settledReason : null,
    settledBy: thread.state === "settled" ? thread.settledBy : null,
    snoozedUntil: thread.state === "snoozed" ? thread.snoozedUntil : null,
    snoozeOnReply: thread.state === "snoozed" && thread.snoozeOnReply,
    suggestion:
      thread.state === "active" && thread.suggestionReason !== null
        ? { reason: thread.suggestionReason, confidence: thread.suggestionConfidence ?? 0 }
        : null,
    category: thread.category,
    guardrail: thread.guardrail,
    nudge: thread.nudge,
    hasDraft,
    chatThreadId: thread.chatThreadId === null ? null : ThreadId.make(thread.chatThreadId),
    injectionWarning: thread.injection,
    triagePending: thread.triageState === "pending" || thread.triageState === "waiting_model",
  };
}

const toMessage = (row: Row): StoredMessage => ({
  id: num(row.id),
  accountId: MailAccountId.make(str(row.account_id)),
  mailbox: str(row.mailbox),
  uid: num(row.uid),
  messageId: strOrNull(row.message_id),
  threadId: MailThreadId.make(str(row.thread_id)),
  labels: json<ReadonlyArray<string> | null>(row.labels, null),
  inInbox: bool(row.in_inbox),
  from: { name: str(row.from_name), address: str(row.from_address) },
  to: json<ReadonlyArray<MailAddress>>(row.to_json, []),
  cc: json<ReadonlyArray<MailAddress>>(row.cc_json, []),
  subject: str(row.subject),
  date: str(row.date),
  inReplyTo: strOrNull(row.in_reply_to),
  references: json<ReadonlyArray<string>>(row.references_json, []),
  seen: bool(row.seen),
  outgoing: bool(row.outgoing),
  size: num(row.size),
  attachments: json<ReadonlyArray<MailAttachment>>(row.attachments_json, []),
  listUnsubscribe: bool(row.list_unsubscribe),
  listId: strOrNull(row.list_id),
  precedence: strOrNull(row.precedence),
  autoSubmitted: strOrNull(row.auto_submitted),
  calendar: bool(row.calendar),
  textPart: json<StoredMessage["textPart"]>(row.text_part, null),
  body: strOrNull(row.body),
  bodyState: str(row.body_state) as StoredMessage["bodyState"],
  removed: bool(row.removed),
});

export function messageView(message: StoredMessage, clean: (text: string) => string): MailMessage {
  return {
    id: String(message.id),
    from: message.from,
    to: message.to,
    cc: message.cc,
    date: message.date,
    subject: message.subject,
    text: message.body === null ? null : clean(message.body),
    fullText: message.body,
    attachments: message.attachments,
    outgoing: message.outgoing,
    unread: !message.seen && !message.outgoing,
  };
}

const toTrust = (row: Row): TrustRecord => ({
  key: str(row.key),
  kind: str(row.kind) as TrustRecord["kind"],
  reason: strOrNull(row.reason) as MailSettleReason | null,
  approvals: num(row.approvals),
  rejections: num(row.rejections),
  streak: num(row.streak),
  trust: str(row.trust) as MailTrustLevel,
  explicit: bool(row.explicit),
  bulk: row.bulk === null || row.bulk === undefined ? null : bool(row.bulk),
});

const toAction = (row: Row): ActionRecord => ({
  id: num(row.id),
  at: str(row.at),
  actor: str(row.actor) as MailActor,
  actorLabel: strOrNull(row.actor_label),
  kind: str(row.kind) as MailActionKind,
  threadId: row.thread_id === null ? null : MailThreadId.make(str(row.thread_id)),
  reason: strOrNull(row.reason),
  undo: json<ActionRecord["undo"]>(row.undo_json, null),
  undoneAt: strOrNull(row.undone_at),
});

export function actionEntry(
  action: ActionRecord,
  thread: Pick<ThreadRecord, "subject" | "fromName" | "fromAddress"> | null,
): MailActionEntry {
  return {
    id: action.id,
    at: action.at,
    actor: action.actor,
    actorLabel: action.actorLabel,
    kind: action.kind,
    threadId: action.threadId,
    subject: thread?.subject ?? null,
    from: thread ? thread.fromName || thread.fromAddress : null,
    reason: action.reason,
    undoable: action.undo !== null && action.undoneAt === null,
    undoneAt: action.undoneAt,
  };
}

const toDraft = (row: Row): DraftRecord => ({
  id: MailDraftId.make(str(row.id)),
  threadId: MailThreadId.make(str(row.thread_id)),
  accountId: MailAccountId.make(str(row.account_id)),
  to: json<ReadonlyArray<string>>(row.to_json, []),
  cc: json<ReadonlyArray<string>>(row.cc_json, []),
  subject: str(row.subject),
  body: str(row.body),
  origin: str(row.origin) as MailActor,
  status: str(row.status) as MailDraft["status"],
  error: strOrNull(row.error),
  updatedAt: str(row.updated_at),
  sentAt: strOrNull(row.sent_at),
  originalBody: strOrNull(row.original_body),
  messageId: strOrNull(row.message_id),
  revision: num(row.revision),
});

export const draftView = ({ originalBody: _o, messageId: _m, ...draft }: DraftRecord): MailDraft =>
  draft;

const PATCH_COLUMNS: Record<keyof ThreadStatePatch, string> = {
  state: "state",
  stateAt: "state_at",
  pinnedAt: "pinned_at",
  workingReason: "working_reason",
  settledReason: "settled_reason",
  settledBy: "settled_by",
  snoozedUntil: "snoozed_until",
  snoozeOnReply: "snooze_on_reply",
  suggestionReason: "suggestion_reason",
  suggestionConfidence: "suggestion_confidence",
  nudge: "nudge",
  unread: "unread",
};

const toSqlValue = (value: unknown): string | number | null =>
  typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number | null);

const makeStore = (sql: SqlClient.SqlClient) => {
  const migrate = Effect.gen(function* () {
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* sql`PRAGMA synchronous = NORMAL`;
    yield* sql`PRAGMA busy_timeout = 5000`;
    const [row] = yield* sql<{ user_version: number }>`PRAGMA user_version`;
    const current = row?.user_version ?? 0;
    for (let version = current; version < MIGRATIONS.length; version++) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const statement of MIGRATIONS[version]!) yield* sql.unsafe(statement);
          yield* sql.unsafe(`PRAGMA user_version = ${version + 1}`);
        }),
      );
    }
  }).pipe(Effect.withSpan("MailStore.migrate"));

  const getKv = (key: string) =>
    sql<{ value: string }>`SELECT value FROM mail_kv WHERE key = ${key}`.pipe(
      Effect.map((rows) => rows[0]?.value ?? null),
    );
  const setKv = (key: string, value: string) =>
    sql`INSERT INTO mail_kv (key, value) VALUES (${key}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(Effect.asVoid);

  const listAccounts = sql<Row>`SELECT * FROM mail_accounts ORDER BY created_at`.pipe(
    Effect.map((rows) => rows.map(toAccount)),
  );
  const getAccount = (id: MailAccountId) =>
    sql<Row>`SELECT * FROM mail_accounts WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] ? toAccount(rows[0]) : null)),
    );
  const insertAccount = (account: AccountRow) =>
    sql`INSERT INTO mail_accounts (id, email, display_name, provider, imap_host, imap_port, imap_tls,
          smtp_host, smtp_port, smtp_tls, username, credential_store, status, status_detail,
          last_sync_at, backfill_paused_until, created_at)
        VALUES (${account.id}, ${account.email}, ${account.displayName}, ${account.provider},
          ${account.imapHost}, ${account.imapPort}, ${account.imapTls ? 1 : 0}, ${account.smtpHost},
          ${account.smtpPort}, ${account.smtpTls ? 1 : 0}, ${account.username},
          ${account.credentialStore}, ${account.status}, ${account.statusDetail},
          ${account.lastSyncAt}, ${account.backfillPausedUntil}, ${account.createdAt})`.pipe(
      Effect.asVoid,
    );
  const updateAccount = (
    id: MailAccountId,
    patch: Partial<
      Pick<
        AccountRow,
        | "status"
        | "statusDetail"
        | "lastSyncAt"
        | "backfillPausedUntil"
        | "displayName"
        | "credentialStore"
      >
    >,
  ) => {
    const columns: Record<string, string> = {
      status: "status",
      statusDetail: "status_detail",
      lastSyncAt: "last_sync_at",
      backfillPausedUntil: "backfill_paused_until",
      displayName: "display_name",
      credentialStore: "credential_store",
    };
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return Effect.void;
    const assignments = entries.map(([key]) => `${columns[key]} = ?`).join(", ");
    return sql
      .unsafe(`UPDATE mail_accounts SET ${assignments} WHERE id = ?`, [
        ...entries.map(([, value]) => toSqlValue(value)),
        id,
      ])
      .pipe(Effect.asVoid);
  };
  const deleteAccount = (id: MailAccountId) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM mail_search WHERE rowid IN (SELECT id FROM mail_messages WHERE account_id = ${id})`;
        yield* sql`DELETE FROM mail_messages WHERE account_id = ${id}`;
        yield* sql`DELETE FROM mail_drafts WHERE account_id = ${id}`;
        yield* sql`DELETE FROM mail_actions WHERE thread_id IN (SELECT id FROM mail_threads WHERE account_id = ${id})`;
        yield* sql`DELETE FROM mail_threads WHERE account_id = ${id}`;
        yield* sql`DELETE FROM mail_mailboxes WHERE account_id = ${id}`;
        yield* sql`DELETE FROM mail_ops WHERE account_id = ${id}`;
        yield* sql`DELETE FROM mail_accounts WHERE id = ${id}`;
      }),
    );
  const accountMessageCount = (id: MailAccountId) =>
    sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM mail_messages WHERE account_id = ${id} AND removed = 0`.pipe(
      Effect.map((rows) => num(rows[0]?.count)),
    );

  const getMailbox = (accountId: MailAccountId, path: string) =>
    sql<Row>`SELECT * FROM mail_mailboxes WHERE account_id = ${accountId} AND path = ${path}`.pipe(
      Effect.map((rows): MailboxState | null =>
        rows[0]
          ? {
              accountId,
              path,
              role: str(rows[0].role),
              uidValidity: str(rows[0].uid_validity),
              maxUid: num(rows[0].max_uid),
              minUid: rows[0].min_uid === null ? null : num(rows[0].min_uid),
              highestModseq: strOrNull(rows[0].highest_modseq),
              backfillDone: bool(rows[0].backfill_done),
            }
          : null,
      ),
    );
  const listMailboxes = (accountId: MailAccountId) =>
    sql<Row>`SELECT path, backfill_done FROM mail_mailboxes WHERE account_id = ${accountId}`.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ path: str(row.path), backfillDone: bool(row.backfill_done) })),
      ),
    );
  const putMailbox = (state: MailboxState) =>
    sql`INSERT INTO mail_mailboxes (account_id, path, role, uid_validity, max_uid, min_uid, highest_modseq, backfill_done)
        VALUES (${state.accountId}, ${state.path}, ${state.role}, ${state.uidValidity}, ${state.maxUid},
          ${state.minUid}, ${state.highestModseq}, ${state.backfillDone ? 1 : 0})
        ON CONFLICT (account_id, path) DO UPDATE SET role = excluded.role,
          uid_validity = excluded.uid_validity, max_uid = excluded.max_uid, min_uid = excluded.min_uid,
          highest_modseq = excluded.highest_modseq, backfill_done = excluded.backfill_done`.pipe(
      Effect.asVoid,
    );
  /** UIDVALIDITY changed: every cached UID of the mailbox is meaningless. */
  const resetMailbox = (accountId: MailAccountId, path: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM mail_search WHERE rowid IN (SELECT id FROM mail_messages WHERE account_id = ${accountId} AND mailbox = ${path})`;
        yield* sql`DELETE FROM mail_messages WHERE account_id = ${accountId} AND mailbox = ${path}`;
        yield* sql`DELETE FROM mail_mailboxes WHERE account_id = ${accountId} AND path = ${path}`;
      }),
    );

  const findThreadIdByMessageIds = (accountId: MailAccountId, messageIds: ReadonlyArray<string>) =>
    messageIds.length === 0
      ? Effect.succeed(null)
      : sql<{ thread_id: string }>`SELECT thread_id FROM mail_messages
          WHERE account_id = ${accountId} AND message_id IN ${sql.in(messageIds)} LIMIT 1`.pipe(
          Effect.map((rows) => (rows[0] ? MailThreadId.make(rows[0].thread_id) : null)),
        );

  /** Inserts or refreshes one synced message. Returns whether it was new. */
  const upsertMessage = Effect.fnUntraced(function* (message: MessageInsert) {
    const existing = yield* sql<{ id: number }>`SELECT id FROM mail_messages
        WHERE account_id = ${message.accountId} AND mailbox = ${message.mailbox} AND uid = ${message.uid}`;
    if (existing[0]) {
      yield* sql`UPDATE mail_messages SET seen = ${message.seen ? 1 : 0},
            labels = ${message.labels === null ? null : toJson(message.labels)},
            in_inbox = ${message.inInbox ? 1 : 0}, removed = 0
          WHERE id = ${existing[0].id}`;
      return { id: num(existing[0].id), inserted: false };
    }
    if (message.outgoing) {
      const recipients = [...message.to, ...message.cc].map((entry) => entry.address.toLowerCase());
      for (const address of new Set(recipients)) {
        yield* sql`INSERT OR IGNORE INTO mail_contacts (account_id, address)
            VALUES (${message.accountId}, ${address})`;
      }
    }
    // The server's copy of a message sent from here takes over the local row, body and all.
    if (message.messageId !== null && message.outgoing) {
      const local = yield* sql<{ id: number }>`UPDATE mail_messages
          SET mailbox = ${message.mailbox}, uid = ${message.uid},
            labels = ${message.labels === null ? null : toJson(message.labels)},
            in_inbox = ${message.inInbox ? 1 : 0}
          WHERE account_id = ${message.accountId} AND mailbox = '__local'
            AND message_id = ${message.messageId}
          RETURNING id`;
      if (local[0]) return { id: num(local[0].id), inserted: false };
    }
    const rows = yield* sql<{
      id: number;
    }>`INSERT INTO mail_messages (account_id, mailbox, uid, message_id,
          thread_id, labels, in_inbox, from_name, from_address, to_json, cc_json, subject, date,
          in_reply_to, references_json, seen, outgoing, size, attachments_json, list_unsubscribe,
          list_id, precedence, auto_submitted, calendar, text_part, body, body_state)
        VALUES (${message.accountId}, ${message.mailbox}, ${message.uid}, ${message.messageId},
          ${message.threadId}, ${message.labels === null ? null : toJson(message.labels)},
          ${message.inInbox ? 1 : 0}, ${message.from.name}, ${message.from.address},
          ${toJson(message.to)}, ${toJson(message.cc)}, ${message.subject},
          ${message.date}, ${message.inReplyTo}, ${toJson(message.references)},
          ${message.seen ? 1 : 0}, ${message.outgoing ? 1 : 0}, ${message.size},
          ${toJson(message.attachments)}, ${message.listUnsubscribe ? 1 : 0},
          ${message.listId}, ${message.precedence}, ${message.autoSubmitted},
          ${message.calendar ? 1 : 0},
          ${message.textPart === null ? null : toJson(message.textPart)}, NULL,
          ${message.textPart === null ? "unavailable" : "pending"})
        RETURNING id`;
    const id = num(rows[0]?.id);
    yield* sql`INSERT INTO mail_search (rowid, subject, sender, body)
        VALUES (${id}, ${message.subject}, ${`${message.from.name} ${message.from.address}`}, '')`;
    return { id, inserted: true };
  });

  /** A failed download stays pending for a few more tries before the text counts as missing. */
  const bodyFetchFailed = (id: number, maxAttempts: number) =>
    sql`UPDATE mail_messages SET body_attempts = body_attempts + 1,
        body_state = CASE WHEN body_attempts + 1 >= ${maxAttempts} THEN 'unavailable' ELSE body_state END
      WHERE id = ${id}`.pipe(Effect.asVoid);

  const setMessageBody = Effect.fnUntraced(function* (id: number, body: string | null) {
    yield* sql`UPDATE mail_messages SET body = ${body}, body_state = ${body === null ? "unavailable" : "loaded"} WHERE id = ${id}`;
    if (body !== null) {
      yield* sql`UPDATE mail_search SET body = ${body.slice(0, SEARCH_BODY_CHARS)} WHERE rowid = ${id}`;
    }
  });

  const pendingBodies = (accountId: MailAccountId, mailbox: string, limit: number) =>
    sql<{
      id: number;
      uid: number;
      text_part: string;
      thread_id: string;
    }>`SELECT id, uid, text_part, thread_id FROM mail_messages
      WHERE account_id = ${accountId} AND mailbox = ${mailbox} AND body_state = 'pending' AND removed = 0
      ORDER BY date DESC LIMIT ${limit}`;

  const updateFlags = (
    accountId: MailAccountId,
    mailbox: string,
    uid: number,
    patch: {
      readonly seen?: boolean;
      readonly labels?: ReadonlyArray<string>;
      readonly inInbox?: boolean;
    },
  ) =>
    sql<{ thread_id: string }>`UPDATE mail_messages SET
        seen = COALESCE(${patch.seen === undefined ? null : patch.seen ? 1 : 0}, seen),
        labels = COALESCE(${patch.labels === undefined ? null : toJson(patch.labels)}, labels),
        in_inbox = COALESCE(${patch.inInbox === undefined ? null : patch.inInbox ? 1 : 0}, in_inbox)
      WHERE account_id = ${accountId} AND mailbox = ${mailbox} AND uid = ${uid}
      RETURNING thread_id`.pipe(
      Effect.map((rows) => (rows[0] ? MailThreadId.make(rows[0].thread_id) : null)),
    );

  const markRemoved = (accountId: MailAccountId, mailbox: string, uids: ReadonlyArray<number>) =>
    uids.length === 0
      ? Effect.succeed([] as ReadonlyArray<MailThreadId>)
      : sql<{ thread_id: string }>`UPDATE mail_messages SET removed = 1, in_inbox = 0
          WHERE account_id = ${accountId} AND mailbox = ${mailbox} AND uid IN ${sql.in(uids)}
          RETURNING thread_id`.pipe(
          Effect.map((rows) => [...new Set(rows.map((row) => MailThreadId.make(row.thread_id)))]),
        );

  const moveMessage = (id: number, mailbox: string, uid: number, inInbox: boolean) =>
    sql`UPDATE mail_messages SET mailbox = ${mailbox}, uid = ${uid}, in_inbox = ${inInbox ? 1 : 0}
      WHERE id = ${id}`.pipe(Effect.asVoid);

  const knownUids = (accountId: MailAccountId, mailbox: string, minUid: number) =>
    sql<{ uid: number }>`SELECT uid FROM mail_messages WHERE account_id = ${accountId}
      AND mailbox = ${mailbox} AND removed = 0 AND uid >= ${minUid}`.pipe(
      Effect.map((rows) => rows.map((row) => num(row.uid))),
    );

  const threadMessages = (threadId: MailThreadId) =>
    sql<Row>`SELECT * FROM mail_messages WHERE thread_id = ${threadId} AND removed = 0
      ORDER BY date ASC, id ASC`.pipe(
      Effect.map((rows) => {
        // Gmail lists one message under several mailboxes only in rare setups; show it once.
        const seen = new Set<string>();
        return rows.map(toMessage).filter((message) => {
          const key = message.messageId ?? `id:${message.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }),
    );

  const messageUidsForThread = (threadId: MailThreadId) =>
    sql<{
      id: number;
      mailbox: string;
      uid: number;
      in_inbox: number;
    }>`SELECT id, mailbox, uid, in_inbox
      FROM mail_messages WHERE thread_id = ${threadId} AND removed = 0 AND mailbox != '__local'`;

  const getThread = (id: MailThreadId) =>
    sql<Row>`SELECT * FROM mail_threads WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] ? toThread(rows[0]) : null)),
    );
  const getThreads = (ids: ReadonlyArray<MailThreadId>) =>
    ids.length === 0
      ? Effect.succeed([] as ReadonlyArray<ThreadRecord>)
      : sql<Row>`SELECT * FROM mail_threads WHERE id IN ${sql.in(ids)}`.pipe(
          Effect.map((rows) => rows.map(toThread)),
        );

  const insertThread = (thread: ThreadRecord) =>
    sql`INSERT INTO mail_threads (id, account_id, subject, from_name, from_address, line,
        suggested_action, last_message_at, last_incoming_at, last_outgoing_at, message_count,
        incoming_count, unread, in_inbox, state, state_at, pinned_at, working_reason, settled_reason,
        settled_by, snoozed_until, snooze_on_reply, suggestion_reason, suggestion_confidence,
        category, guardrail, bulk, verdict_json, triage_state, triaged_count, nudge, chat_thread_id,
        injection, created_at)
      VALUES (${thread.id}, ${thread.accountId}, ${thread.subject}, ${thread.fromName},
        ${thread.fromAddress}, ${thread.line}, ${thread.suggestedAction}, ${thread.lastMessageAt},
        ${thread.lastIncomingAt}, ${thread.lastOutgoingAt}, ${thread.messageCount},
        ${thread.incomingCount}, ${thread.unread ? 1 : 0}, ${thread.inInbox ? 1 : 0},
        ${thread.state}, ${thread.stateAt}, ${thread.pinnedAt}, ${thread.workingReason},
        ${thread.settledReason}, ${thread.settledBy}, ${thread.snoozedUntil},
        ${thread.snoozeOnReply ? 1 : 0}, ${thread.suggestionReason},
        ${thread.suggestionConfidence}, ${thread.category}, ${thread.guardrail},
        ${thread.bulk ? 1 : 0},
        ${thread.verdict === null ? null : toJson(thread.verdict)}, ${thread.triageState},
        ${thread.triagedCount}, ${thread.nudge}, ${thread.chatThreadId},
        ${thread.injection ? 1 : 0}, ${thread.createdAt})`.pipe(Effect.asVoid);

  /** Recomputes the thread's message-derived columns; state columns are left alone. */
  const refreshThreadAggregate = Effect.fnUntraced(function* (id: MailThreadId) {
    const messages = yield* threadMessages(id);
    if (messages.length === 0) return null;
    const incoming = messages.filter((message) => !message.outgoing);
    const latestIncoming = incoming.at(-1) ?? messages.at(-1)!;
    const first = messages[0]!;
    const last = messages.at(-1)!;
    const outgoing = messages.filter((message) => message.outgoing);
    yield* sql`UPDATE mail_threads SET
          subject = ${first.subject || last.subject},
          from_name = ${latestIncoming.from.name},
          from_address = ${latestIncoming.from.address},
          last_message_at = ${last.date},
          last_incoming_at = ${incoming.at(-1)?.date ?? null},
          last_outgoing_at = ${outgoing.at(-1)?.date ?? null},
          message_count = ${messages.length},
          incoming_count = ${incoming.length},
          unread = ${incoming.some((message) => !message.seen) ? 1 : 0},
          in_inbox = ${messages.some((message) => message.inInbox) ? 1 : 0}
        WHERE id = ${id}`;
    return yield* getThread(id);
  });

  const patchThread = (id: MailThreadId, patch: ThreadStatePatch) => {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return Effect.void;
    const assignments = entries
      .map(([key]) => `${PATCH_COLUMNS[key as keyof ThreadStatePatch]} = ?`)
      .join(", ");
    return sql
      .unsafe(`UPDATE mail_threads SET ${assignments} WHERE id = ?`, [
        ...entries.map(([, value]) => toSqlValue(value)),
        id,
      ])
      .pipe(Effect.asVoid);
  };

  const setTriage = (
    id: MailThreadId,
    patch: {
      readonly line?: string;
      readonly suggestedAction?: string | null;
      readonly category?: MailCategory | null;
      readonly guardrail?: MailGuardrail | null;
      readonly bulk?: boolean;
      readonly verdict?: ThreadVerdict | null;
      readonly triageState: ThreadRecord["triageState"];
      readonly triagedCount?: number;
      readonly injection?: boolean;
    },
  ) =>
    sql`UPDATE mail_threads SET
        line = COALESCE(${patch.line ?? null}, line),
        suggested_action = CASE WHEN ${patch.suggestedAction === undefined ? 0 : 1} = 1 THEN ${patch.suggestedAction ?? null} ELSE suggested_action END,
        category = CASE WHEN ${patch.category === undefined ? 0 : 1} = 1 THEN ${patch.category ?? null} ELSE category END,
        guardrail = CASE WHEN ${patch.guardrail === undefined ? 0 : 1} = 1 THEN ${patch.guardrail ?? null} ELSE guardrail END,
        bulk = COALESCE(${patch.bulk === undefined ? null : patch.bulk ? 1 : 0}, bulk),
        verdict_json = CASE WHEN ${patch.verdict === undefined ? 0 : 1} = 1 THEN ${patch.verdict ? toJson(patch.verdict) : null} ELSE verdict_json END,
        triage_state = ${patch.triageState},
        triaged_count = COALESCE(${patch.triagedCount ?? null}, triaged_count),
        injection = COALESCE(${patch.injection === undefined ? null : patch.injection ? 1 : 0}, injection)
      WHERE id = ${id}`.pipe(Effect.asVoid);

  const setChatThread = (id: MailThreadId, chatThreadId: string | null) =>
    sql`UPDATE mail_threads SET chat_thread_id = ${chatThreadId} WHERE id = ${id}`.pipe(
      Effect.asVoid,
    );

  const pendingTriage = (limit: number) =>
    sql<{ id: string }>`SELECT id FROM mail_threads WHERE triage_state = 'pending'
      ORDER BY last_message_at DESC LIMIT ${limit}`.pipe(
      Effect.map((rows) => rows.map((row) => MailThreadId.make(row.id))),
    );
  const requeueWaitingTriage = sql`UPDATE mail_threads SET triage_state = 'pending'
    WHERE triage_state IN ('waiting_model', 'capped')`.pipe(Effect.asVoid);

  /** Every unsettled thread plus the newest settled ones: the sidebar's whole working set. */
  const openThreads = (settledLimit: number) =>
    sql<Row>`SELECT * FROM (SELECT * FROM mail_threads WHERE state != 'settled' OR pinned_at IS NOT NULL)
      UNION ALL
      SELECT * FROM (SELECT * FROM mail_threads WHERE state = 'settled' AND pinned_at IS NULL
        ORDER BY state_at DESC, id DESC LIMIT ${settledLimit})`.pipe(
      Effect.map((rows) => rows.map(toThread)),
    );

  const settledPage = (input: {
    readonly before: { readonly at: string; readonly id: string } | undefined;
    readonly reason: MailSettleReason | undefined;
    readonly byAi: boolean | undefined;
    readonly limit: number;
  }) =>
    sql<Row>`SELECT * FROM mail_threads WHERE state = 'settled'
        ${input.before ? sql`AND (state_at < ${input.before.at} OR (state_at = ${input.before.at} AND id < ${input.before.id}))` : sql``}
        ${input.reason ? sql`AND settled_reason = ${input.reason}` : sql``}
        ${input.byAi === true ? sql`AND settled_by = 'ai'` : sql``}
      ORDER BY state_at DESC, id DESC LIMIT ${input.limit + 1}`.pipe(
      Effect.map((rows) => ({
        threads: rows.slice(0, input.limit).map(toThread),
        hasMore: rows.length > input.limit,
      })),
    );

  const countSettled = sql<{
    count: number;
  }>`SELECT COUNT(*) AS count FROM mail_threads WHERE state = 'settled'`.pipe(
    Effect.map((rows) => num(rows[0]?.count)),
  );

  const dueSnoozes = (now: string) =>
    sql<Row>`SELECT * FROM mail_threads WHERE state = 'snoozed' AND snoozed_until IS NOT NULL
      AND snoozed_until <= ${now}`.pipe(Effect.map((rows) => rows.map(toThread)));

  const threadsByState = (state: MailThreadState) =>
    sql<Row>`SELECT * FROM mail_threads WHERE state = ${state}`.pipe(
      Effect.map((rows) => rows.map(toThread)),
    );

  const repliedWaiting = (olderThan: string) =>
    sql<Row>`SELECT * FROM mail_threads WHERE nudge IS NULL AND last_outgoing_at IS NOT NULL
      AND last_outgoing_at = last_message_at AND last_outgoing_at <= ${olderThan}
      AND ((state = 'working' AND working_reason = 'waiting') OR (state = 'settled' AND settled_reason = 'replied'))`.pipe(
      Effect.map((rows) => rows.map(toThread)),
    );

  const relatedThreads = (fromAddress: string, excludeId: MailThreadId, limit: number) =>
    sql<Row>`SELECT * FROM mail_threads WHERE from_address = ${fromAddress} AND id != ${excludeId}
      ORDER BY last_message_at DESC LIMIT ${limit}`.pipe(Effect.map((rows) => rows.map(toThread)));

  const latestMessage = (threadId: MailThreadId) =>
    sql<Row>`SELECT * FROM mail_messages WHERE thread_id = ${threadId} AND removed = 0
      ORDER BY date DESC, id DESC LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] ? toMessage(rows[0]) : null)),
    );

  const repliedToAddresses = (accountId: MailAccountId, addresses: ReadonlyArray<string>) =>
    addresses.length === 0
      ? Effect.succeed(new Set<string>())
      : sql<{ address: string }>`SELECT address FROM mail_contacts WHERE account_id = ${accountId}
          AND address IN ${sql.in(addresses.map((address) => address.toLowerCase()))}`.pipe(
          Effect.map((rows) => new Set(rows.map((row) => row.address))),
        );

  const sentSamples = (limit: number) =>
    sql<Row>`SELECT * FROM mail_messages WHERE outgoing = 1 AND body IS NOT NULL
      ORDER BY date DESC LIMIT ${limit}`.pipe(Effect.map((rows) => rows.map(toMessage)));

  const search = (match: string | null, like: string, limit: number) =>
    (match === null
      ? sql<{ thread_id: string }>`SELECT DISTINCT thread_id FROM mail_messages
          WHERE removed = 0 AND (subject LIKE ${like} OR from_name LIKE ${like} OR from_address LIKE ${like} OR body LIKE ${like})
          ORDER BY date DESC LIMIT ${limit}`
      : sql<{ thread_id: string }>`SELECT m.thread_id AS thread_id FROM mail_search s
          JOIN mail_messages m ON m.id = s.rowid
          WHERE mail_search MATCH ${match} AND m.removed = 0
          GROUP BY m.thread_id ORDER BY MAX(m.date) DESC LIMIT ${limit}`
    ).pipe(Effect.map((rows) => rows.map((row) => MailThreadId.make(row.thread_id))));

  const findMessageByGmailId = (accountId: MailAccountId, messageId: string) =>
    sql<{
      id: number;
    }>`SELECT id FROM mail_messages WHERE account_id = ${accountId} AND message_id = ${messageId} LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  const getTrust = (keys: ReadonlyArray<string>) =>
    keys.length === 0
      ? Effect.succeed(new Map<string, TrustRecord>())
      : sql<Row>`SELECT * FROM mail_trust WHERE key IN ${sql.in(keys)}`.pipe(
          Effect.map((rows) => new Map(rows.map((row) => [str(row.key), toTrust(row)]))),
        );
  const putTrust = (record: TrustRecord, now: string) =>
    sql`INSERT INTO mail_trust (key, kind, reason, approvals, rejections, streak, trust, explicit, bulk, updated_at)
      VALUES (${record.key}, ${record.kind}, ${record.reason}, ${record.approvals},
        ${record.rejections}, ${record.streak}, ${record.trust}, ${record.explicit ? 1 : 0},
        ${record.bulk === null ? null : record.bulk ? 1 : 0}, ${now})
      ON CONFLICT (key) DO UPDATE SET reason = excluded.reason, approvals = excluded.approvals,
        rejections = excluded.rejections, streak = excluded.streak, trust = excluded.trust,
        explicit = excluded.explicit, bulk = excluded.bulk, updated_at = excluded.updated_at`.pipe(
      Effect.asVoid,
    );
  const deleteTrust = (key: string) =>
    sql`DELETE FROM mail_trust WHERE key = ${key}`.pipe(Effect.asVoid);
  const listTrust = sql<Row>`SELECT * FROM mail_trust ORDER BY updated_at DESC LIMIT 500`.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({ record: toTrust(row), updatedAt: str(row.updated_at) })),
    ),
  );

  const insertAction = (action: Omit<ActionRecord, "id" | "undoneAt">) =>
    sql<{
      id: number;
    }>`INSERT INTO mail_actions (at, actor, actor_label, kind, thread_id, reason, undo_json)
      VALUES (${action.at}, ${action.actor}, ${action.actorLabel}, ${action.kind}, ${action.threadId},
        ${action.reason}, ${action.undo === null ? null : toJson(action.undo)})
      RETURNING id`.pipe(Effect.map((rows) => num(rows[0]?.id)));
  const getAction = (id: number) =>
    sql<Row>`SELECT * FROM mail_actions WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] ? toAction(rows[0]) : null)),
    );
  const markActionUndone = (id: number, at: string) =>
    sql`UPDATE mail_actions SET undone_at = ${at} WHERE id = ${id}`.pipe(Effect.asVoid);
  const listActions = (input: {
    readonly beforeId: number | undefined;
    readonly actor: MailActor | undefined;
    readonly threadId: MailThreadId | undefined;
    readonly limit: number;
  }) =>
    sql<Row>`SELECT * FROM mail_actions WHERE 1 = 1
        ${input.beforeId === undefined ? sql`` : sql`AND id < ${input.beforeId}`}
        ${input.actor === undefined ? sql`` : sql`AND actor = ${input.actor}`}
        ${input.threadId === undefined ? sql`` : sql`AND thread_id = ${input.threadId}`}
      ORDER BY id DESC LIMIT ${input.limit + 1}`.pipe(
      Effect.map((rows) => ({
        actions: rows.slice(0, input.limit).map(toAction),
        hasMore: rows.length > input.limit,
      })),
    );
  const actionsSince = (since: string) =>
    sql<Row>`SELECT * FROM mail_actions WHERE at >= ${since} AND undone_at IS NULL ORDER BY id`.pipe(
      Effect.map((rows) => rows.map(toAction)),
    );
  const threadsCreatedSince = (since: string) =>
    sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM mail_threads WHERE created_at >= ${since}`.pipe(
      Effect.map((rows) => num(rows[0]?.count)),
    );

  const draftsForThread = (threadId: MailThreadId) =>
    sql<Row>`SELECT * FROM mail_drafts WHERE thread_id = ${threadId} ORDER BY updated_at`.pipe(
      Effect.map((rows) => rows.map(toDraft)),
    );
  const threadsWithDrafts = (ids: ReadonlyArray<MailThreadId>) =>
    ids.length === 0
      ? Effect.succeed(new Set<string>())
      : sql<{ thread_id: string }>`SELECT DISTINCT thread_id FROM mail_drafts
          WHERE status IN ('draft', 'failed') AND thread_id IN ${sql.in(ids)}`.pipe(
          Effect.map((rows) => new Set(rows.map((row) => row.thread_id))),
        );
  const getDraft = (id: MailDraftId) =>
    sql<Row>`SELECT * FROM mail_drafts WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] ? toDraft(rows[0]) : null)),
    );
  /** Saves an edit. Every save bumps the revision, so a send approves exactly one version. */
  const saveDraftContent = (draft: DraftRecord) =>
    sql<Row>`INSERT INTO mail_drafts (id, thread_id, account_id, to_json, cc_json, subject, body,
        origin, original_body, status, error, message_id, revision, updated_at, sent_at)
      VALUES (${draft.id}, ${draft.threadId}, ${draft.accountId}, ${toJson(draft.to)},
        ${toJson(draft.cc)}, ${draft.subject}, ${draft.body}, ${draft.origin},
        ${draft.originalBody}, 'draft', NULL, NULL, 0, ${draft.updatedAt}, NULL)
      ON CONFLICT (id) DO UPDATE SET to_json = excluded.to_json, cc_json = excluded.cc_json,
        subject = excluded.subject, body = excluded.body, status = 'draft', error = NULL,
        message_id = NULL, revision = mail_drafts.revision + 1, updated_at = excluded.updated_at
      WHERE mail_drafts.status IN ('draft', 'failed')
      RETURNING *`.pipe(Effect.map((rows) => (rows[0] ? toDraft(rows[0]) : null)));
  /**
   * Claims one reviewed revision for sending; a retry or a second tap finds it taken. The
   * Message-ID is fixed on the first claim so a resend after an unclear failure reuses it.
   */
  const claimDraftForSend = (id: MailDraftId, revision: number, messageId: string, now: string) =>
    sql<Row>`UPDATE mail_drafts SET status = 'sending', error = NULL, updated_at = ${now},
        message_id = COALESCE(message_id, ${messageId})
      WHERE id = ${id} AND status IN ('draft', 'failed') AND revision = ${revision}
      RETURNING *`.pipe(Effect.map((rows) => (rows[0] ? toDraft(rows[0]) : null)));
  const finishDraftSend = (
    id: MailDraftId,
    result: {
      readonly status: "sent" | "failed";
      readonly error: string | null;
      readonly at: string;
    },
  ) =>
    sql`UPDATE mail_drafts SET status = ${result.status}, error = ${result.error},
        updated_at = ${result.at}, sent_at = ${result.status === "sent" ? result.at : null}
      WHERE id = ${id} AND status = 'sending'`.pipe(Effect.asVoid);
  /** A send cut off by a crash or restart may or may not have reached the server. */
  const recoverInterruptedSends = (now: string, error: string) =>
    sql`UPDATE mail_drafts SET status = 'failed', error = ${error}, updated_at = ${now}
      WHERE status = 'sending'`.pipe(Effect.asVoid);
  /** Threads whose last message was expunged or reset away. */
  const deleteEmptyThreads = (accountId: MailAccountId) =>
    sql<{ id: string }>`DELETE FROM mail_threads WHERE account_id = ${accountId}
        AND NOT EXISTS (SELECT 1 FROM mail_messages
          WHERE mail_messages.thread_id = mail_threads.id AND mail_messages.removed = 0)
      RETURNING id`.pipe(Effect.map((rows) => rows.map((row) => MailThreadId.make(row.id))));

  const deleteDraft = (id: MailDraftId) =>
    sql`DELETE FROM mail_drafts WHERE id = ${id} AND status != 'sending'`.pipe(Effect.asVoid);

  const insertUsage = (usage: {
    readonly at: string;
    readonly kind: string;
    readonly model: string;
    readonly tokens: number;
    readonly emails: number;
  }) =>
    sql`INSERT INTO mail_usage (at, kind, model, tokens, emails)
      VALUES (${usage.at}, ${usage.kind}, ${usage.model}, ${usage.tokens}, ${usage.emails})`.pipe(
      Effect.asVoid,
    );
  const usageSince = (since: string) =>
    sql<{
      tokens: number;
      calls: number;
      emails: number;
    }>`SELECT COALESCE(SUM(tokens), 0) AS tokens,
        COUNT(*) AS calls, COALESCE(SUM(emails), 0) AS emails FROM mail_usage WHERE at >= ${since}`.pipe(
      Effect.map((rows) => ({
        tokens: num(rows[0]?.tokens),
        calls: num(rows[0]?.calls),
        emails: num(rows[0]?.emails),
      })),
    );

  const enqueueOp = (accountId: MailAccountId, kind: string, payload: unknown, now: string) =>
    sql`INSERT INTO mail_ops (account_id, kind, payload, created_at)
      VALUES (${accountId}, ${kind}, ${toJson(payload)}, ${now})`.pipe(Effect.asVoid);
  const pendingOps = (accountId: MailAccountId) =>
    sql<{
      id: number;
      kind: string;
      payload: string;
      attempts: number;
    }>`SELECT id, kind, payload, attempts
      FROM mail_ops WHERE account_id = ${accountId} ORDER BY id LIMIT 50`;
  const finishOp = (id: number) => sql`DELETE FROM mail_ops WHERE id = ${id}`.pipe(Effect.asVoid);
  const failOp = (id: number) =>
    sql`UPDATE mail_ops SET attempts = attempts + 1 WHERE id = ${id}`.pipe(Effect.asVoid);
  const dropFailedOps = sql`DELETE FROM mail_ops WHERE attempts >= 5`.pipe(Effect.asVoid);

  return {
    sql,
    migrate,
    getKv,
    setKv,
    listAccounts,
    getAccount,
    insertAccount,
    updateAccount,
    deleteAccount,
    accountMessageCount,
    getMailbox,
    listMailboxes,
    putMailbox,
    resetMailbox,
    findThreadIdByMessageIds,
    upsertMessage,
    setMessageBody,
    bodyFetchFailed,
    pendingBodies,
    updateFlags,
    markRemoved,
    moveMessage,
    knownUids,
    threadMessages,
    messageUidsForThread,
    getThread,
    getThreads,
    insertThread,
    refreshThreadAggregate,
    patchThread,
    setTriage,
    setChatThread,
    pendingTriage,
    requeueWaitingTriage,
    openThreads,
    settledPage,
    countSettled,
    dueSnoozes,
    threadsByState,
    repliedWaiting,
    relatedThreads,
    latestMessage,
    repliedToAddresses,
    sentSamples,
    search,
    findMessageByGmailId,
    getTrust,
    putTrust,
    deleteTrust,
    listTrust,
    insertAction,
    getAction,
    markActionUndone,
    listActions,
    actionsSince,
    threadsCreatedSince,
    draftsForThread,
    threadsWithDrafts,
    getDraft,
    deleteEmptyThreads,
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => sql.withTransaction(effect),
    saveDraftContent,
    claimDraftForSend,
    finishDraftSend,
    recoverInterruptedSends,
    deleteDraft,
    insertUsage,
    usageSince,
    enqueueOp,
    pendingOps,
    finishOp,
    failOp,
    dropFailedOps,
  };
};

type StoreApi = ReturnType<typeof makeStore>;
type StoreError = SqlError.SqlError;

export class MailStore extends Context.Service<
  MailStore,
  StoreApi & { readonly mailDir: string; readonly workspaceDir: string }
>()("t3/mail/MailStore") {}

export type { StoreError };

const layerFromPath = (mailDir: string) =>
  Layer.effect(
    MailStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeStore(sql);
      yield* store.migrate;
      const path = yield* Path.Path;
      return MailStore.of({ ...store, mailDir, workspaceDir: path.join(mailDir, "workspace") });
    }),
  ).pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.makeDirectory(path.join(mailDir, "workspace"), { recursive: true });
          return NodeSqliteClient.layer({
            filename: path.join(mailDir, "mail.sqlite"),
            readerWorker: true,
            writerWorker: true,
            spanAttributes: { "db.name": "mail.sqlite", "service.name": "t3code-server" },
          });
        }),
      ),
    ),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerFromPath(path.join(config.stateDir, "mail"));
  }),
);

/** In-memory store for tests; `mailDir` still names a real folder for EMAIL.md. */
export const layerMemory = (mailDir: string) =>
  Layer.effect(
    MailStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeStore(sql);
      yield* store.migrate;
      return MailStore.of({ ...store, mailDir, workspaceDir: `${mailDir}/workspace` });
    }),
  ).pipe(Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
