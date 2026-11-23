import {
  type MailAccountStatus,
  type MailActionEntry,
  type MailActionKind,
  type MailActor,
  type MailAddress,
  type MailAttachment,
  type MailCategory,
  type MailDraft,
  type MailDraftFile,
  type MailGuardrail,
  type MailMessage,
  type MailListLabeledInput,
  type MailProviderKind,
  type MailSettleReason,
  type MailSettings,
  type MailRule,
  type MailThreadRow,
  type MailThreadState,
  type MailWorkingReason,
  MailAccountId,
  MailDraftId,
  MailThreadId,
  ThreadId,
  type MailDecidedBy,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";

import * as ServerConfig from "../config.ts";
import { signInCodeLifetime } from "./signInCode.ts";
import type { TrustClock, TrustRecord, TrustUndo } from "./mailTrust.ts";

const workflowColumns = [
  "state",
  "state_at",
  "working_reason",
  "settled_reason",
  "settled_by",
  "snoozed_until",
  "snooze_on_reply",
  "suggestion_reason",
  "suggestion_confidence",
  "nudge",
  "last_message_at",
  "message_count",
  "incoming_count",
];

// A thread only the user wrote in is named by its first recipient (To, then Cc), as Sent mail is.
const FIRST_RECIPIENT = `CASE WHEN json_extract(to_json, '$[0].address') IS NOT NULL THEN to_json
    WHEN json_extract(cc_json, '$[0].address') IS NOT NULL THEN cc_json END`;
const SENDER_COLUMNS = `CASE WHEN outgoing = 1 AND ${FIRST_RECIPIENT} IS NOT NULL
    THEN COALESCE(json_extract(${FIRST_RECIPIENT}, '$[0].name'), '') ELSE from_name END AS from_name,
  CASE WHEN outgoing = 1 AND ${FIRST_RECIPIENT} IS NOT NULL
    THEN json_extract(${FIRST_RECIPIENT}, '$[0].address') ELSE from_address END AS from_address`;

export const DEFAULT_SETTINGS: MailSettings = {
  defaultModelSelection: null,
  escalationModelSelection: null,
  weeklyTokenCap: 300_000,
  codeCleanupEnabled: false,
  codeInboxMinutes: 5,
  codeReadMinutes: 1,
  serverMirroring: false,
  recapEnabled: true,
  notificationsEnabled: true,
  nudgeReplyDays: 3,
  nudgeWaitingDays: 5,
  syncEnabled: true,
  rules: [],
  aiExcludedSenders: [],
};

const indexMessageLabels = `INSERT OR IGNORE INTO mail_message_labels(message_id, thread_id, label)
  SELECT NEW.id, NEW.thread_id, value FROM json_each(NEW.labels)
  WHERE NEW.removed = 0 AND value != '' AND substr(value, 1, 1) != char(92)`;

// Each entry runs once, in order; `PRAGMA user_version` records how many ran.
type MailMigration =
  | readonly string[]
  | ((sql: SqlClient.SqlClient) => Effect.Effect<void, SqlError.SqlError>);
const MIGRATIONS: ReadonlyArray<MailMigration> = [
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
  [
    `CREATE TABLE mail_reset_messages (
      account_id TEXT NOT NULL, mailbox TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
      PRIMARY KEY (account_id, mailbox, thread_id, message_id)
    ) WITHOUT ROWID`,
    `CREATE INDEX mail_reset_messages_message_id ON mail_reset_messages (account_id, message_id)`,
    `CREATE INDEX mail_reset_messages_thread ON mail_reset_messages (thread_id)`,
  ],
  [
    `ALTER TABLE mail_drafts ADD COLUMN edit_sender TEXT`,
    `CREATE INDEX mail_drafts_edit_sender ON mail_drafts (account_id, edit_sender, sent_at DESC)
      WHERE edit_sender IS NOT NULL`,
    `INSERT INTO mail_kv (key, value) SELECT 'local-sent-uid', COALESCE(MIN(uid), 0)
      FROM mail_messages WHERE mailbox = '__local' AND uid < 0`,
  ],
  [
    `ALTER TABLE mail_messages ADD COLUMN mirror_origin TEXT`,
    `ALTER TABLE mail_messages ADD COLUMN moved_uid_validity TEXT`,
    `CREATE INDEX mail_ops_account_kind ON mail_ops(account_id, kind)`,
  ],
  [
    `ALTER TABLE mail_threads ADD COLUMN workflow_version TEXT`,
    `ALTER TABLE mail_threads ADD COLUMN pin_version TEXT`,
    ...(
      [
        ["workflow_version", workflowColumns],
        ["pin_version", ["pinned_at"]],
      ] as const
    ).map(([version, fields]) => {
      return `CREATE TRIGGER bump_${version} AFTER UPDATE OF ${fields.join(", ")} ON mail_threads
        WHEN ${fields.map((field) => `NEW.${field} IS NOT OLD.${field}`).join(" OR ")}
        BEGIN UPDATE mail_threads SET ${version} = hex(randomblob(16)) WHERE id = NEW.id; END`;
    }),
    `ALTER TABLE mail_messages ADD COLUMN read_action TEXT`,
    `CREATE INDEX mail_messages_read_action ON mail_messages(read_action) WHERE read_action IS NOT NULL`,
    `CREATE TRIGGER invalidate_read_action AFTER UPDATE OF seen, removed ON mail_messages
      WHEN (OLD.seen IS NOT NEW.seen OR OLD.removed IS NOT NEW.removed) AND OLD.read_action = NEW.read_action
      BEGIN UPDATE mail_messages SET read_action = NULL WHERE id = NEW.id; END`,
    `CREATE TABLE mail_trust_clock (key TEXT PRIMARY KEY, revision INTEGER NOT NULL,
      setting INTEGER NOT NULL, reset INTEGER NOT NULL)`,
    // Original snapshots lack the resulting state. Their history is retained for display.
    `UPDATE mail_actions SET undo_json = CASE WHEN json_type(undo_json, '$.draftId') = 'text'
      THEN json_object('draft', json_object('id', json_extract(undo_json, '$.draftId'), 'revision', 0, 'before', NULL))
      ELSE NULL END WHERE undo_json IS NOT NULL`,
    `CREATE VIEW mail_action_history AS
      SELECT a.id, a.at, a.actor, a.actor_label, a.kind, a.thread_id, a.reason, a.undone_at,
        CASE WHEN
          (a.thread_id IS NOT NULL AND t.id IS NULL)
          OR (json_type(a.undo_json, '$.thread') IS NOT NULL AND
            json_extract(a.undo_json, '$.thread.version') IS NOT CASE
              WHEN json_type(a.undo_json, '$.thread.after.pinnedAt') IS NOT NULL THEN t.pin_version
              ELSE t.workflow_version END)
          OR (json_type(a.undo_json, '$.draft') IS NOT NULL AND
            (d.status IS NOT 'draft' OR d.revision IS NOT json_extract(a.undo_json, '$.draft.revision')))
          OR (json_extract(a.undo_json, '$.trust.effect') = 'level' AND
            c.revision IS NOT json_extract(a.undo_json, '$.trust.entry.clock.revision'))
          OR (json_type(a.undo_json, '$.read') IS NOT NULL AND
            json_extract(a.undo_json, '$.read.count') <> (SELECT count(*) FROM mail_messages m
              WHERE m.read_action = json_extract(a.undo_json, '$.read.token') AND m.removed = 0))
        THEN NULL ELSE a.undo_json END AS undo_json
      FROM mail_actions a LEFT JOIN mail_threads t ON t.id = a.thread_id
      LEFT JOIN mail_drafts d ON d.id = json_extract(a.undo_json, '$.draft.id')
      LEFT JOIN mail_trust_clock c ON c.key = json_extract(a.undo_json, '$.trust.entry.key')`,
  ],
  [
    // Older file-backed accounts may have a keychain copy from a failed write or migration.
    `ALTER TABLE mail_accounts ADD COLUMN keychain_possible INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE mail_accounts ADD COLUMN credential_pending INTEGER NOT NULL DEFAULT 0`,
  ],
  [
    `UPDATE mail_trust SET explicit = 0 WHERE explicit = 1 AND trust = 'auto' AND
      (SELECT reason FROM mail_actions WHERE kind = 'trust' AND actor_label = mail_trust.key
        AND undone_at IS NULL ORDER BY id DESC LIMIT 1) IS NOT 'auto'`,
  ],
  [
    `CREATE TABLE mail_display_bodies (id INTEGER PRIMARY KEY, content TEXT NOT NULL)`,
    `CREATE TRIGGER delete_mail_display_body AFTER DELETE ON mail_messages
      BEGIN DELETE FROM mail_display_bodies WHERE id = OLD.id; END`,
  ],
  [`CREATE INDEX mail_threads_state_latest ON mail_threads (state, last_message_at DESC, id DESC)`],
  [
    `CREATE INDEX mail_threads_chat ON mail_threads(chat_thread_id) WHERE chat_thread_id IS NOT NULL`,
    `CREATE TABLE mail_triage_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, at TEXT NOT NULL,
      text TEXT NOT NULL, published_chat TEXT
    )`,
    `CREATE INDEX mail_triage_notes_thread ON mail_triage_notes(thread_id, id)`,
    `CREATE TRIGGER delete_mail_triage_notes AFTER DELETE ON mail_threads
      BEGIN DELETE FROM mail_triage_notes WHERE thread_id = OLD.id; END`,
  ],
  [`ALTER TABLE mail_threads DROP COLUMN line`],
  [
    // NULL means not read yet; sync fills it in for mail stored before it was recorded.
    `ALTER TABLE mail_messages ADD COLUMN reply_to_json TEXT`,
    `ALTER TABLE mail_drafts ADD COLUMN mode TEXT NOT NULL DEFAULT 'reply'`,
    `ALTER TABLE mail_drafts ADD COLUMN target_message INTEGER`,
  ],
  [
    // "held": mail from before the account was connected, waiting for the user to send it to AI.
    // "review": held mail the user sent, sorted after new mail.
    `DROP INDEX mail_threads_triage`,
    `CREATE INDEX mail_threads_triage ON mail_threads (triage_state, last_message_at)`,
  ],
  [
    `CREATE INDEX mail_threads_sent ON mail_threads (last_outgoing_at DESC, id DESC)
      WHERE last_outgoing_at IS NOT NULL`,
    `UPDATE mail_threads SET (from_name, from_address) = (SELECT ${SENDER_COLUMNS}
        FROM mail_messages WHERE thread_id = mail_threads.id AND removed = 0
        ORDER BY date DESC, id DESC LIMIT 1)
      WHERE incoming_count = 0 AND message_count > 0
        AND EXISTS (SELECT 1 FROM mail_messages WHERE thread_id = mail_threads.id AND removed = 0)`,
  ],
  [
    // Approvals no longer graduate a sender or category; only the user's rules settle alone.
    `UPDATE mail_trust SET trust = 'suggest' WHERE trust = 'auto'`,
    `ALTER TABLE mail_trust DROP COLUMN streak`,
    `ALTER TABLE mail_trust DROP COLUMN explicit`,
    `ALTER TABLE mail_trust DROP COLUMN bulk`,
  ],
  [
    // Never show became a rule; the senders it hid become rules the user can see in Settings.
    `INSERT OR IGNORE INTO mail_kv (key, value) SELECT 'settings', '${JSON.stringify(DEFAULT_SETTINGS)}'
       WHERE EXISTS (SELECT 1 FROM mail_trust WHERE trust = 'never' AND kind = 'sender')`,
    `UPDATE mail_kv SET value = json_set(value, '$.rules', json(
        (SELECT json_group_array(json(rule)) FROM (
          SELECT json_remove(r.value, '$.action', '$.sensitive') AS rule FROM json_each(mail_kv.value, '$.rules') r
            WHERE json_extract(r.value, '$.action') IS NOT 'keep'
          UNION ALL SELECT json_object('id', 'never-show-' || substr(t.key, 8), 'enabled', json('true'),
            'match', json_object('from', '<' || substr(t.key, 8) || '>'), 'reason', 'noise')
            FROM mail_trust t WHERE t.trust = 'never' AND t.kind = 'sender'))))
      WHERE key = 'settings' AND json_valid(value)`,
    `UPDATE mail_actions SET kind = 'settle', undo_json = json_remove(undo_json, '$.trust')
      WHERE kind = 'never_show'`,
    `DELETE FROM mail_actions WHERE kind = 'trust'`,
    `ALTER TABLE mail_trust DROP COLUMN trust`,
  ],
  [
    `ALTER TABLE mail_accounts ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE mail_accounts ADD COLUMN folders TEXT NOT NULL DEFAULT '[]'`,
    `CREATE TABLE mail_message_labels(message_id INTEGER NOT NULL, thread_id TEXT NOT NULL, label TEXT NOT NULL,
       PRIMARY KEY(message_id, label)) WITHOUT ROWID`,
    `CREATE INDEX mail_label_threads ON mail_message_labels(label,thread_id)`,
    `CREATE INDEX mail_thread_labels ON mail_message_labels(thread_id,label)`,
    `INSERT OR IGNORE INTO mail_message_labels SELECT m.id,m.thread_id,j.value
      FROM mail_messages m, json_each(m.labels) j WHERE m.removed = 0 AND j.value != '' AND substr(j.value,1,1) != char(92)`,
    `CREATE TRIGGER mail_labels_insert AFTER INSERT ON mail_messages BEGIN ${indexMessageLabels}; END`,
    `CREATE TRIGGER mail_labels_update AFTER UPDATE OF labels, thread_id, removed ON mail_messages
      WHEN OLD.labels IS NOT NEW.labels OR OLD.thread_id != NEW.thread_id OR OLD.removed != NEW.removed
      BEGIN DELETE FROM mail_message_labels WHERE message_id = OLD.id; ${indexMessageLabels}; END`,
    `CREATE TRIGGER mail_labels_delete AFTER DELETE ON mail_messages BEGIN
       DELETE FROM mail_message_labels WHERE message_id = OLD.id; END`,
    `UPDATE mail_mailboxes SET highest_modseq = NULL WHERE account_id IN
       (SELECT id FROM mail_accounts WHERE provider != 'gmail')`,
  ],
  [
    `ALTER TABLE mail_messages ADD COLUMN code_received_at INTEGER`,
    `ALTER TABLE mail_messages ADD COLUMN code_read_at INTEGER`,
    `ALTER TABLE mail_messages ADD COLUMN code_lifetime INTEGER`,
    `CREATE INDEX mail_code_candidates ON mail_messages(code_received_at) WHERE code_received_at IS NOT NULL`,
    `CREATE INDEX mail_code_handled ON mail_actions(json_extract(undo_json, '$.trash.accountId'),
        json_extract(undo_json, '$.trash.messageIds[0]')) WHERE reason = 'sign_in_code'`,
    `CREATE TRIGGER mail_code_read AFTER UPDATE OF seen ON mail_messages
      WHEN NEW.seen = 1 AND OLD.seen = 0 AND NEW.code_received_at IS NOT NULL AND NEW.code_read_at IS NULL
      BEGIN UPDATE mail_messages SET code_read_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE id = NEW.id; END`,
  ],
  [
    `ALTER TABLE mail_drafts ADD COLUMN bcc_json TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE mail_drafts ADD COLUMN files_json TEXT NOT NULL DEFAULT '[]'`,
    // Uploaded before a draft names them, so a file outlives the draft until pruned; undo can bring it back.
    `CREATE TABLE mail_draft_files (id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
      content BLOB NOT NULL, created_at TEXT NOT NULL)`,
  ],
  (sql) =>
    Effect.gen(function* () {
      // Some development databases already have the file metadata columns at version 19.
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(mail_draft_files)`;
      if (columns.some(({ name }) => name === "filename")) return;
      yield* sql`ALTER TABLE mail_draft_files ADD COLUMN filename TEXT NOT NULL DEFAULT 'attachment'`;
      yield* sql`ALTER TABLE mail_draft_files ADD COLUMN content_type TEXT NOT NULL DEFAULT 'application/octet-stream'`;
      yield* sql`ALTER TABLE mail_draft_files ADD COLUMN size INTEGER NOT NULL DEFAULT 0`;
      yield* sql`UPDATE mail_draft_files SET size = length(content)`;
      yield* sql`UPDATE mail_draft_files AS f SET
      filename = COALESCE(json_extract(item.value, '$.filename'), f.filename),
      content_type = COALESCE(json_extract(item.value, '$.contentType'), f.content_type)
      FROM mail_drafts AS d, json_each(d.files_json) AS item
      WHERE json_extract(item.value, '$.id') = f.id AND d.account_id = f.account_id`;
    }),
  [`ALTER TABLE mail_messages ADD COLUMN bcc_json TEXT`],
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
  /** Null when this copy was stored before Reply-To was recorded. */
  readonly replyTo?: ReadonlyArray<MailAddress> | null;
  readonly to: ReadonlyArray<MailAddress>;
  readonly cc: ReadonlyArray<MailAddress>;
  readonly bcc?: ReadonlyArray<MailAddress> | undefined;
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
  readonly codeCleanupPending: boolean;
  readonly id: number;
  readonly body: string | null;
  readonly bodyState: "pending" | "loaded" | "unavailable";
  readonly removed: boolean;
}

export interface AccountRow {
  readonly labels?: ReadonlyArray<string>;
  readonly folders?: ReadonlyArray<string>;
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
  readonly keychainPossible: boolean;
  readonly credentialPending: boolean;
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
  /**
   * "user_rule" is the user's own rule or Never show. "rule" (built-in category guesses) and
   * "memory" only appear on verdicts stored before every email went to the model.
   */
  readonly source: "user_rule" | "rule" | "memory" | "model" | "escalated";
  /** The model's one-line reason; absent on rules and older verdicts. */
  readonly why?: string | null;
  readonly by?: MailDecidedBy | null;
  /** The user's rule that matched: exactly, or by the model reading its condition. */
  readonly ruleId?: string | null;
  /** The model's short name for this type of email, offered as a new rule's condition. */
  readonly kind?: string | null;
}

export interface ThreadRecord {
  readonly workflowVersion: string | null;
  readonly pinVersion: string | null;
  readonly id: MailThreadId;
  readonly accountId: MailAccountId;
  readonly subject: string;
  readonly fromName: string;
  readonly fromAddress: string;
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
  readonly triageState: "pending" | "review" | "held" | "done" | "waiting_model" | "capped";
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

export const MessageTarget = Schema.Struct({ id: Schema.Int, identity: Schema.String });
export type MessageTarget = typeof MessageTarget.Type;

/** Where reported spam landed, so Not spam can find mail without a Message-ID (UIDPLUS). */
export interface SpamCopies {
  readonly folder: string;
  readonly uidValidity: string | null;
  readonly copies: ReadonlyArray<{
    readonly uid: number | null;
    readonly messageId: string | null;
  }>;
}

export interface MirrorUndo {
  readonly kind: "archive" | "unarchive";
  readonly targets: ReadonlyArray<MessageTarget>;
}

export interface ThreadChange {
  readonly before: ThreadStatePatch;
  readonly after: ThreadStatePatch;
  readonly version: string;
}
type DraftContent = Pick<
  DraftRecord,
  | "body"
  | "to"
  | "cc"
  | "bcc"
  | "files"
  | "subject"
  | "status"
  | "error"
  | "messageId"
  | "mode"
  | "targetMessageId"
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
    readonly thread?: ThreadChange;
    readonly trust?: TrustUndo;
    /** A rule the action added, removed again by undo. */
    readonly rule?: MailRule;
    readonly mirror?: MirrorUndo;
    readonly discardedDraft?: DraftRecord;
    /** A new email's thread, removed with its only draft and put back by undo. */
    readonly composed?: ThreadRecord;
    readonly draft?: {
      readonly id: MailDraftId;
      readonly revision: number;
      readonly before: Partial<DraftContent> | null;
    };
    readonly read?: {
      readonly token: string;
      readonly count: number;
      readonly targets: ReadonlyArray<MessageTarget>;
      /** Set when the action marked mail unread, so undo reads it again. */
      readonly unread?: boolean;
    };
    readonly trash?: {
      readonly accountId: MailAccountId;
      readonly messageIds: ReadonlyArray<string>;
      /** Kept so Trash can name the email after its thread is gone. */
      readonly subject?: string;
      readonly from?: string;
      readonly spam?: SpamCopies;
    };
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
  labels: json<string[]>(row.labels, []),
  folders: json<string[]>(row.folders, []),
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
  keychainPossible: bool(row.keychain_possible),
  credentialPending: bool(row.credential_pending),
  status: str(row.status) as MailAccountStatus,
  statusDetail: strOrNull(row.status_detail),
  lastSyncAt: strOrNull(row.last_sync_at),
  backfillPausedUntil: strOrNull(row.backfill_paused_until),
  createdAt: str(row.created_at),
});

const toThread = (row: Row): ThreadRecord => ({
  workflowVersion: strOrNull(row.workflow_version),
  pinVersion: strOrNull(row.pin_version),
  id: MailThreadId.make(str(row.id)),
  accountId: MailAccountId.make(str(row.account_id)),
  subject: str(row.subject),
  fromName: str(row.from_name),
  fromAddress: str(row.from_address),
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
    suggestedAction: thread.suggestedAction,
    lastMessageAt: thread.lastMessageAt,
    lastOutgoingAt: thread.lastOutgoingAt,
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
        ? {
            reason: thread.suggestionReason,
            confidence: thread.suggestionConfidence ?? 0,
            revision: thread.workflowVersion ?? "initial",
            byRule: thread.verdict?.source === "user_rule",
          }
        : null,
    category: thread.category,
    guardrail: thread.guardrail,
    nudge: thread.nudge,
    hasDraft,
    chatThreadId: thread.chatThreadId === null ? null : ThreadId.make(thread.chatThreadId),
    injectionWarning: thread.injection,
    triagePending: thread.triageState === "pending" || thread.triageState === "waiting_model",
    // A verdict on older mail would explain a decision the newest mail hasn't had yet.
    why: thread.triageState === "done" ? (thread.verdict?.why ?? null) : null,
    decidedBy: thread.triageState === "done" ? (thread.verdict?.by ?? null) : null,
    ruleId: thread.triageState === "done" ? (thread.verdict?.ruleId ?? null) : null,
  };
}

const toMessage = (row: Row): StoredMessage => ({
  codeCleanupPending: row.code_received_at != null && row.code_lifetime != null,
  id: num(row.id),
  accountId: MailAccountId.make(str(row.account_id)),
  mailbox: str(row.mailbox),
  uid: num(row.uid),
  messageId: strOrNull(row.message_id),
  threadId: MailThreadId.make(str(row.thread_id)),
  labels: json<ReadonlyArray<string> | null>(row.labels, null),
  inInbox: bool(row.in_inbox),
  from: { name: str(row.from_name), address: str(row.from_address) },
  replyTo: json<ReadonlyArray<MailAddress> | null>(row.reply_to_json, null),
  to: json<ReadonlyArray<MailAddress>>(row.to_json, []),
  cc: json<ReadonlyArray<MailAddress>>(row.cc_json, []),
  bcc: json<ReadonlyArray<MailAddress>>(row.bcc_json, []),
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
    listId: message.listId,
    replyTo: message.replyTo ?? [],
    to: message.to,
    cc: message.cc,
    ...(message.outgoing && message.bcc?.length ? { bcc: message.bcc } : {}),
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
    subject: thread?.subject ?? action.undo?.trash?.subject ?? null,
    from: thread ? thread.fromName || thread.fromAddress : (action.undo?.trash?.from ?? null),
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
  bcc: json<ReadonlyArray<string>>(row.bcc_json, []),
  files: json<ReadonlyArray<MailDraftFile>>(row.files_json, []),
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
  mode: str(row.mode) === "forward" ? "forward" : "reply",
  targetMessageId:
    row.target_message === null || row.target_message === undefined
      ? null
      : String(num(row.target_message)),
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
          const migration = MIGRATIONS[version]!;
          if (typeof migration === "function") yield* migration(sql);
          else for (const statement of migration) yield* sql.unsafe(statement);
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
  const nextLocalSentUid = sql<{
    uid: number;
  }>`UPDATE mail_kv SET value = CAST(value AS INTEGER) - 1
      WHERE key = 'local-sent-uid' RETURNING CAST(value AS INTEGER) AS uid`.pipe(
    Effect.map((rows) => rows[0]!.uid),
  );

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
          last_sync_at, backfill_paused_until, created_at, keychain_possible, credential_pending)
        VALUES (${account.id}, ${account.email}, ${account.displayName}, ${account.provider},
          ${account.imapHost}, ${account.imapPort}, ${account.imapTls ? 1 : 0}, ${account.smtpHost},
          ${account.smtpPort}, ${account.smtpTls ? 1 : 0}, ${account.username},
          ${account.credentialStore}, ${account.status}, ${account.statusDetail},
          ${account.lastSyncAt}, ${account.backfillPausedUntil}, ${account.createdAt},
          ${account.keychainPossible ? 1 : 0}, ${account.credentialPending ? 1 : 0})`.pipe(
      Effect.asVoid,
    );
  const setLabelCatalog = (
    id: MailAccountId,
    labels: ReadonlyArray<string>,
    folders: ReadonlyArray<string>,
  ) => {
    const names = toJson(labels);
    const paths = toJson(folders);
    return sql`UPDATE mail_accounts SET labels = ${names}, folders = ${paths}
      WHERE id = ${id} AND (labels != ${names} OR folders != ${paths})`.pipe(Effect.asVoid);
  };
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
        | "keychainPossible"
        | "credentialPending"
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
      keychainPossible: "keychain_possible",
      credentialPending: "credential_pending",
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
        yield* sql`DELETE FROM mail_draft_files WHERE account_id = ${id}`;
        // Thread IDs retain the account prefix even after their last message was expunged.
        const prefix = `${id}:`;
        // Trust is shared. Keep a key when another inbox uses it or a global setting names it.
        const exclusiveKeys = sql`(
          WITH sources(key, thread_id) AS (
            SELECT 'sender:' || lower(from_address), id FROM mail_threads
            UNION ALL SELECT 'category:' || category, id FROM mail_threads WHERE category IS NOT NULL
            UNION ALL SELECT json_extract(entry.value, '$.key'), action.thread_id
              FROM mail_actions AS action, json_each(action.undo_json, '$.trust.entries') AS entry
            UNION ALL SELECT json_extract(undo_json, '$.trust.entry.key'), thread_id FROM mail_actions
              WHERE json_type(undo_json, '$.trust.entry') = 'object'
            UNION ALL SELECT actor_label, NULL FROM mail_actions WHERE kind = 'trust' AND thread_id IS NULL
          )
          SELECT key FROM sources GROUP BY key HAVING min(coalesce(instr(thread_id, ${prefix}), 0) = 1)
        )`;
        yield* sql`DELETE FROM mail_trust_clock WHERE key IN ${exclusiveKeys}`;
        yield* sql`DELETE FROM mail_trust WHERE key IN ${exclusiveKeys}`;
        yield* sql`DELETE FROM mail_actions WHERE instr(thread_id, ${prefix}) = 1
          OR (reason = 'sign_in_code' AND json_extract(undo_json, '$.trash.accountId') = ${id})`;
        yield* sql`DELETE FROM mail_contacts WHERE account_id = ${id}`;
        // Legacy reply examples have no ownership information.
        yield* sql`DELETE FROM mail_kv WHERE key IN ('draft-edits', ${"body-quota:" + id}) OR key IN (
          SELECT 'chat-context:' || chat_thread_id FROM mail_threads WHERE account_id = ${id}
        )`;
        yield* sql`DELETE FROM mail_threads WHERE account_id = ${id}`;
        yield* sql`DELETE FROM mail_mailboxes WHERE account_id = ${id}`;
        yield* sql`DELETE FROM mail_reset_messages WHERE account_id = ${id}`;
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
    sql<Row>`SELECT path, role, backfill_done FROM mail_mailboxes WHERE account_id = ${accountId}`.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          path: str(row.path),
          role: str(row.role),
          backfillDone: bool(row.backfill_done),
        })),
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
  // Message-IDs still identify replies that backfill reaches before their parents in the new UID space.
  const resetMailbox = (accountId: MailAccountId, path: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT OR IGNORE INTO mail_reset_messages (account_id, mailbox, thread_id, message_id)
          SELECT account_id, mailbox, thread_id, COALESCE(message_id, '') FROM mail_messages
          WHERE account_id = ${accountId} AND mailbox = ${path} AND removed = 0`;
        yield* sql`DELETE FROM mail_search WHERE rowid IN (SELECT id FROM mail_messages WHERE account_id = ${accountId} AND mailbox = ${path})`;
        yield* sql`DELETE FROM mail_messages WHERE account_id = ${accountId} AND mailbox = ${path}`;
        yield* sql`DELETE FROM mail_mailboxes WHERE account_id = ${accountId} AND path = ${path}`;
      }),
    );

  const findThreadIdByMessageIds = (
    accountId: MailAccountId,
    messageIds: ReadonlyArray<string>,
    ownId: string | null,
  ) =>
    messageIds.length === 0
      ? Effect.succeed(null)
      : sql<{ thread_id: string }>`SELECT thread_id FROM mail_messages
          WHERE account_id = ${accountId} AND message_id IN ${sql.in(messageIds)}
          UNION ALL SELECT thread_id FROM mail_reset_messages
          WHERE account_id = ${accountId} AND message_id IN ${sql.in(ownId ? [ownId, ...messageIds] : messageIds)}
          LIMIT 1`.pipe(
          Effect.map((rows) => (rows[0] ? MailThreadId.make(rows[0].thread_id) : null)),
        );

  /** Inserts or refreshes one synced message. Returns whether it was new. */
  const upsertMessage = Effect.fnUntraced(function* (message: MessageInsert) {
    const bcc = message.outgoing && message.bcc?.length ? toJson(message.bcc) : null;
    const existing = yield* sql<{ id: number }>`SELECT id FROM mail_messages
        WHERE account_id = ${message.accountId} AND mailbox = ${message.mailbox} AND uid = ${message.uid}`;
    if (existing[0]) {
      yield* sql`UPDATE mail_messages SET seen = ${message.seen ? 1 : 0},
            labels = ${message.labels === null ? null : toJson([...message.labels].sort())},
            in_inbox = ${message.inInbox ? 1 : 0}, removed = 0,
            bcc_json = COALESCE(${bcc}, bcc_json),
            reply_to_json = COALESCE(reply_to_json, ${message.replyTo == null ? null : toJson(message.replyTo)})
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
          SET mailbox = ${message.mailbox}, uid = ${message.uid}, bcc_json = COALESCE(${bcc}, bcc_json),
            labels = ${message.labels === null ? null : toJson([...message.labels].sort())},
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
          list_id, precedence, auto_submitted, calendar, text_part, body, body_state, reply_to_json, bcc_json)
        VALUES (${message.accountId}, ${message.mailbox}, ${message.uid}, ${message.messageId},
          ${message.threadId}, ${message.labels === null ? null : toJson([...message.labels].sort())},
          ${message.inInbox ? 1 : 0}, ${message.from.name}, ${message.from.address},
          ${toJson(message.to)}, ${toJson(message.cc)}, ${message.subject},
          ${message.date}, ${message.inReplyTo}, ${toJson(message.references)},
          ${message.seen ? 1 : 0}, ${message.outgoing ? 1 : 0}, ${message.size},
          ${toJson(message.attachments)}, ${message.listUnsubscribe ? 1 : 0},
          ${message.listId}, ${message.precedence}, ${message.autoSubmitted},
          ${message.calendar ? 1 : 0},
          ${message.textPart === null ? null : toJson(message.textPart)}, NULL,
          ${message.textPart === null ? "unavailable" : "pending"},
          ${message.replyTo == null ? null : toJson(message.replyTo)}, ${bcc})
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
    const [row] = yield* sql<{
      subject: string;
      code_received_at: number | null;
    }>`UPDATE mail_messages SET body = ${body}, body_state = ${body === null ? "unavailable" : "loaded"} WHERE id = ${id} RETURNING subject, code_received_at`;
    if (row && row.code_received_at !== null) {
      const lifetime = signInCodeLifetime(row.subject, body ?? "");
      yield* sql`UPDATE mail_messages SET code_lifetime = ${lifetime},
        code_received_at = ${lifetime === null ? null : row.code_received_at} WHERE id = ${id}`;
    }
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

  /** Messages a reader is likely to open that have no formatted body saved yet, newest first. */
  const pendingDisplayBodies = (
    accountId: MailAccountId,
    since: string,
    skip: ReadonlyArray<number>,
    limit: number,
  ) =>
    sql<{ id: number; thread_id: string }>`SELECT m.id, m.thread_id FROM mail_messages m
      JOIN mail_threads t ON t.id = m.thread_id
      LEFT JOIN mail_display_bodies d ON d.id = m.id
      WHERE m.account_id = ${accountId} AND m.removed = 0 AND m.mailbox != '__local' AND d.id IS NULL
        AND (t.state != 'settled' OR t.pinned_at IS NOT NULL OR t.last_message_at >= ${since})
        AND m.id NOT IN (SELECT value FROM json_each(${toJson(skip)}))
      ORDER BY m.date DESC LIMIT ${limit}`;

  const updateFlags = (
    accountId: MailAccountId,
    mailbox: string,
    changes: ReadonlyArray<{
      readonly uid: number;
      readonly seen: boolean;
      readonly labels: ReadonlyArray<string> | null;
      readonly inInbox?: boolean;
    }>,
  ) => {
    if (!changes.length) return Effect.succeed([] as ReadonlyArray<MailThreadId>);
    const flags = changes.map((change) => ({
      ...change,
      labels: change.labels === null ? null : [...change.labels].sort(),
    }));
    // A server poll may finish before the user's queued read or unread reaches the server.
    return sql<{ thread_id: string }>`WITH pending AS MATERIALIZED (
        SELECT json_extract(t.value, '$.id') AS id, json_extract(t.value, '$.identity') AS identity
        FROM mail_ops o, json_each(o.payload, '$.targets') t
        WHERE o.account_id = ${accountId} AND o.kind = 'seen'
      ), desired AS MATERIALIZED (
        SELECT m.id,
          CASE WHEN EXISTS (SELECT 1 FROM pending WHERE pending.id = m.id
            AND pending.identity = COALESCE(m.mirror_origin, json_array(m.mailbox, b.uid_validity, m.uid)))
            THEN m.seen ELSE json_extract(f.value, '$.seen') END AS seen,
          COALESCE(json_extract(f.value, '$.labels'), m.labels) AS labels,
          COALESCE(json_extract(f.value, '$.inInbox'), m.in_inbox) AS in_inbox
        FROM json_each(${toJson(flags)}) f
        CROSS JOIN mail_messages m ON m.account_id = ${accountId} AND m.mailbox = ${mailbox}
          AND m.uid = json_extract(f.value, '$.uid') AND m.removed = 0
        LEFT JOIN mail_mailboxes b ON b.account_id = m.account_id AND b.path = m.mailbox
      )
      UPDATE mail_messages AS m SET seen = d.seen, labels = d.labels, in_inbox = d.in_inbox
      FROM desired d WHERE m.id = d.id
        AND (m.seen != d.seen OR m.labels IS NOT d.labels OR m.in_inbox != d.in_inbox)
      RETURNING thread_id`.pipe(
      Effect.map((rows) => [...new Set(rows.map((row) => MailThreadId.make(row.thread_id)))]),
    );
  };

  const markRemoved = (accountId: MailAccountId, mailbox: string, uids: ReadonlyArray<number>) =>
    uids.length === 0
      ? Effect.succeed([] as ReadonlyArray<MailThreadId>)
      : sql<{ thread_id: string }>`UPDATE mail_messages SET removed = 1, in_inbox = 0
          WHERE account_id = ${accountId} AND mailbox = ${mailbox} AND uid IN ${sql.in(uids)}
          RETURNING thread_id`.pipe(
          Effect.map((rows) => [...new Set(rows.map((row) => MailThreadId.make(row.thread_id)))]),
        );

  const moveMessage = (
    accountId: MailAccountId,
    from: MessageTarget & {
      readonly mailbox: string;
      readonly uid: number;
      readonly uidValidity: string;
    },
    to: { readonly mailbox: string; readonly uid: number; readonly uidValidity: string },
    inInbox: boolean,
  ) =>
    sql`UPDATE mail_messages SET mailbox = ${to.mailbox}, uid = ${to.uid},
      mirror_origin = ${from.identity}, moved_uid_validity = ${to.uidValidity},
      in_inbox = ${Number(inInbox)}
      WHERE id = ${from.id} AND account_id = ${accountId} AND mailbox = ${from.mailbox} AND uid = ${from.uid}
        AND COALESCE(moved_uid_validity, (SELECT uid_validity FROM mail_mailboxes
          WHERE account_id = ${accountId} AND path = ${from.mailbox})) = ${from.uidValidity}`.pipe(
      Effect.asVoid,
    );

  const knownUids = (accountId: MailAccountId, mailbox: string, minUid: number) =>
    sql<{ uid: number }>`SELECT uid FROM mail_messages WHERE account_id = ${accountId}
      AND mailbox = ${mailbox} AND removed = 0 AND uid >= ${minUid}`.pipe(
      Effect.map((rows) => rows.map((row) => num(row.uid))),
    );

  const knownUidsAmong = (accountId: MailAccountId, mailbox: string, uids: ReadonlyArray<number>) =>
    sql<{ uid: number }>`SELECT uid FROM mail_messages WHERE account_id = ${accountId}
      AND mailbox = ${mailbox} AND removed = 0 AND uid IN ${sql.in(uids)}`.pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.uid))),
    );

  const threadMessages = (threadId: MailThreadId, limit?: number) =>
    sql<Row>`SELECT * FROM (SELECT * FROM mail_messages WHERE thread_id = ${threadId} AND removed = 0
      ORDER BY date DESC, id DESC LIMIT ${limit ?? -1}) ORDER BY date ASC, id ASC`.pipe(
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

  // COPYUID is the only proof that a destination UID still names the originally selected message.
  const messageTargets = (threadId: MailThreadId, ids?: ReadonlyArray<number>) =>
    sql<
      MessageTarget & {
        accountId: MailAccountId;
        mailbox: string;
        uid: number;
        uidValidity: string;
        inInbox: number;
        role: string | null;
      }
    >`SELECT m.id, m.account_id AS accountId, m.mailbox, m.uid, m.in_inbox AS inInbox, b.role,
      COALESCE(m.moved_uid_validity, b.uid_validity) AS uidValidity,
      COALESCE(m.mirror_origin, json_array(m.mailbox, b.uid_validity, m.uid)) AS identity
      FROM mail_messages m LEFT JOIN mail_mailboxes b ON b.account_id = m.account_id AND b.path = m.mailbox
      WHERE m.thread_id = ${threadId} AND m.removed = 0 AND m.mailbox != '__local'
        AND COALESCE(m.moved_uid_validity, b.uid_validity) IS NOT NULL
        ${ids === undefined ? sql`` : sql`AND m.id IN (SELECT value FROM json_each(${toJson(ids)}))`}`;

  const mirrorTargets = Effect.fn("MailStore.mirrorTargets")(function* (
    accountId: MailAccountId,
    threadId: MailThreadId,
    kind: MirrorUndo["kind"],
  ) {
    const rows = yield* messageTargets(threadId);
    // An offline unsettle can precede delivery of the archive it reverses.
    const pending = yield* sql<{ identity: string; kind: MirrorUndo["kind"] }>`
      SELECT json_extract(t.value, '$.identity') AS identity, o.kind
      FROM mail_ops o, json_each(o.payload, '$.targets') t
      WHERE o.account_id = ${accountId} AND o.kind IN ('archive', 'unarchive')
        AND json_extract(o.payload, '$.threadId') = ${threadId}
      ORDER BY o.id`;
    const projected = new Map(pending.map((op) => [op.identity, op.kind === "unarchive"]));
    return rows
      .filter(
        (row) =>
          row.role !== "sent" &&
          row.role !== "folder" &&
          (projected.get(row.identity) ?? Boolean(row.inInbox)) === (kind === "archive"),
      )
      .map(({ id, identity }) => ({ id, identity }));
  });

  const getThread = (id: MailThreadId) =>
    sql<Row>`SELECT * FROM mail_threads WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] ? toThread(rows[0]) : null)),
    );
  const getChatMail = (chatId: string) =>
    sql<Row>`SELECT * FROM mail_threads WHERE chat_thread_id = ${chatId} LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] ? toThread(rows[0]) : null)),
    );
  const addTriageNote = (threadId: MailThreadId, at: string, text: string) =>
    sql`INSERT INTO mail_triage_notes(thread_id, at, text) VALUES (${threadId}, ${at}, ${text})`.pipe(
      Effect.asVoid,
    );
  const latestTriageNote = (threadId: MailThreadId) =>
    sql<{
      text: string;
    }>`SELECT text FROM mail_triage_notes WHERE thread_id = ${threadId} ORDER BY id DESC LIMIT 1`.pipe(
      Effect.map((rows) => rows[0]?.text),
    );
  const unpublishedTriageNotes = (threadId: MailThreadId, chatId: string) =>
    sql<{ id: number; at: string; text: string }>`SELECT id, at, text FROM mail_triage_notes
      WHERE thread_id = ${threadId} AND published_chat IS NOT ${chatId} ORDER BY id LIMIT 50`;
  const markTriageNotePublished = (id: number, chatId: string) =>
    sql`UPDATE mail_triage_notes SET published_chat = ${chatId} WHERE id = ${id}`.pipe(
      Effect.asVoid,
    );
  const getThreads = (ids: ReadonlyArray<MailThreadId>) =>
    ids.length === 0
      ? Effect.succeed([] as ReadonlyArray<ThreadRecord>)
      : sql<Row>`SELECT * FROM mail_threads WHERE id IN ${sql.in(ids)}`.pipe(
          Effect.map((rows) => rows.map(toThread)),
        );

  const insertThread = (thread: Omit<ThreadRecord, "workflowVersion" | "pinVersion">) =>
    sql`INSERT INTO mail_threads (id, account_id, subject, from_name, from_address,
        suggested_action, last_message_at, last_incoming_at, last_outgoing_at, message_count,
        incoming_count, unread, in_inbox, state, state_at, pinned_at, working_reason, settled_reason,
        settled_by, snoozed_until, snooze_on_reply, suggestion_reason, suggestion_confidence,
        category, guardrail, bulk, verdict_json, triage_state, triaged_count, nudge, chat_thread_id,
        injection, created_at)
      VALUES (${thread.id}, ${thread.accountId}, ${thread.subject}, ${thread.fromName},
        ${thread.fromAddress}, ${thread.suggestedAction}, ${thread.lastMessageAt},
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
    const rows = yield* sql<Row>`WITH ranked AS (
        SELECT id, date, subject, from_name, from_address, to_json,
          COALESCE(NULLIF(cc_json, '[]'), bcc_json) AS cc_json, outgoing, seen, in_inbox,
          row_number() OVER (PARTITION BY COALESCE(message_id, id) ORDER BY date, id) AS copy
        FROM mail_messages WHERE thread_id = ${id} AND removed = 0
      ), messages AS (SELECT * FROM ranked WHERE copy = 1),
      first AS (SELECT subject FROM messages ORDER BY date, id LIMIT 1),
      last AS (SELECT subject FROM messages ORDER BY date DESC, id DESC LIMIT 1),
      sender AS (SELECT ${sql.literal(SENDER_COLUMNS)} FROM messages ORDER BY outgoing, date DESC, id DESC LIMIT 1)
      UPDATE mail_threads SET
        (subject, from_name, from_address, last_message_at, last_incoming_at, last_outgoing_at,
         message_count, incoming_count, unread, in_inbox) = (
          SELECT COALESCE(NULLIF(first.subject, ''), last.subject), sender.from_name, sender.from_address,
            max(date), max(date) FILTER (WHERE outgoing = 0), max(date) FILTER (WHERE outgoing = 1),
            count(*), count(*) FILTER (WHERE outgoing = 0), max(outgoing = 0 AND seen = 0), max(in_inbox)
          FROM messages, first, last, sender
        )
      WHERE id = ${id} AND EXISTS (SELECT 1 FROM messages)
      RETURNING *`;
    return rows[0] ? toThread(rows[0]) : null;
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

  const patchForAction = Effect.fn("MailStore.patchForAction")(function* (
    thread: ThreadRecord,
    patch: ThreadStatePatch,
  ) {
    const changed = Object.entries(patch).filter(
      ([key, value]) => thread[key as keyof ThreadStatePatch] !== value,
    );
    if (changed.length === 0) return undefined;
    const after: ThreadStatePatch = Object.fromEntries(changed);
    const before: ThreadStatePatch = Object.fromEntries(
      changed.map(([key]) => [key, thread[key as keyof ThreadStatePatch]]),
    );
    yield* patchThread(thread.id, after);
    const [row] = yield* sql<{
      version: string;
    }>`SELECT CASE WHEN ${"pinnedAt" in after ? 1 : 0} THEN pin_version ELSE workflow_version END AS version FROM mail_threads WHERE id = ${thread.id}`;
    return { before, after, version: row!.version } satisfies ThreadChange;
  });

  const refreshUnread = (id: MailThreadId) =>
    sql`UPDATE mail_threads SET unread = EXISTS (SELECT 1 FROM mail_messages
      WHERE thread_id = ${id} AND removed = 0 AND outgoing = 0 AND seen = 0) WHERE id = ${id}`.pipe(
      Effect.asVoid,
    );

  const markMessagesRead = (id: MailThreadId, token: string) =>
    sql<{ id: number }>`UPDATE mail_messages SET seen = 1, read_action = ${token}
      WHERE thread_id = ${id} AND removed = 0 AND outgoing = 0 AND seen = 0 RETURNING id`;
  const undoMessagesRead = (id: MailThreadId, token: string) =>
    sql<{ id: number }>`UPDATE mail_messages SET seen = 0, read_action = NULL
      WHERE thread_id = ${id} AND removed = 0 AND read_action = ${token} AND seen = 1 RETURNING id`;
  const markNewestUnread = (id: MailThreadId, token: string) =>
    sql<{ id: number }>`UPDATE mail_messages SET seen = 0, read_action = ${token}
      WHERE id = (SELECT id FROM mail_messages WHERE thread_id = ${id} AND removed = 0
        AND outgoing = 0 ORDER BY date DESC, id DESC LIMIT 1) AND seen = 1 RETURNING id`;
  const undoMessagesUnread = (id: MailThreadId, token: string) =>
    sql<{ id: number }>`UPDATE mail_messages SET seen = 1, read_action = NULL
      WHERE thread_id = ${id} AND removed = 0 AND read_action = ${token} AND seen = 0 RETURNING id`;

  /** Where each server copy of the thread lives now, for moving it to Trash. */
  const serverLocations = (threadId: MailThreadId) =>
    sql<{ mailbox: string; uid: number; uidValidity: string; messageId: string | null }>`
      SELECT m.mailbox, m.uid, CAST(COALESCE(m.moved_uid_validity, b.uid_validity) AS TEXT) AS uidValidity,
        m.message_id AS messageId
      FROM mail_messages m LEFT JOIN mail_mailboxes b ON b.account_id = m.account_id AND b.path = m.mailbox
      WHERE m.thread_id = ${threadId} AND m.removed = 0 AND m.mailbox != '__local'
        AND COALESCE(m.moved_uid_validity, b.uid_validity) IS NOT NULL`;

  /** Every message still here; a null `uidValidity` has no server copy this side knows of yet. */
  const spamSources = (threadId: MailThreadId) =>
    sql<{
      id: number;
      mailbox: string;
      uid: number;
      uidValidity: string | null;
      messageId: string | null;
    }>`SELECT m.id, m.mailbox, m.uid, m.message_id AS messageId,
        CAST(COALESCE(m.moved_uid_validity, b.uid_validity) AS TEXT) AS uidValidity
      FROM mail_messages m LEFT JOIN mail_mailboxes b ON b.account_id = m.account_id AND b.path = m.mailbox
      WHERE m.thread_id = ${threadId} AND m.removed = 0`;

  /** Removes some of a thread's messages; returns the thread when none are left. */
  const removeMessages = Effect.fn("MailStore.removeMessages")(function* (
    threadId: MailThreadId,
    ids: ReadonlyArray<number>,
  ) {
    if (ids.length === 0) return [];
    yield* sql`UPDATE mail_messages SET removed = 1, in_inbox = 0
      WHERE thread_id = ${threadId} AND removed = 0 AND id IN ${sql.in(ids)}`;
    const removed = yield* deleteExpungedThreads([threadId]);
    if (removed.length === 0) yield* refreshThreadAggregate(threadId);
    return removed;
  });

  /** Removes the thread here at once; messages restored later arrive as new mail. */
  const removeThread = Effect.fn("MailStore.removeThread")(function* (threadId: MailThreadId) {
    yield* sql`UPDATE mail_messages SET removed = 1, in_inbox = 0
      WHERE thread_id = ${threadId} AND removed = 0`;
    return yield* deleteExpungedThreads([threadId]);
  });

  const setTriage = (
    id: MailThreadId,
    patch: {
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

  const queued = (state: "pending" | "review", limit: number) =>
    sql<{ id: string }>`SELECT id FROM mail_threads WHERE triage_state = ${state}
      ORDER BY last_message_at DESC LIMIT ${limit}`.pipe(
      Effect.map((rows) => rows.map((row) => MailThreadId.make(row.id))),
    );
  /** New mail first; existing mail the user sent for review fills what's left of the batch. */
  const pendingTriage = Effect.fn("MailStore.pendingTriage")(function* (limit: number) {
    const fresh = yield* queued("pending", limit);
    return fresh.length < limit
      ? [...fresh, ...(yield* queued("review", limit - fresh.length))]
      : fresh;
  });
  /** Queues up to `limit` held emails, newest first, so mail held later waits for another ask. */
  const setReview = (review: boolean, limit: number | null) =>
    review
      ? sql`UPDATE mail_threads SET triage_state = 'review' WHERE id IN (
          SELECT id FROM mail_threads WHERE triage_state = 'held' AND state = 'active'
          ORDER BY last_message_at DESC LIMIT ${limit ?? -1})`.pipe(Effect.asVoid)
      : sql`UPDATE mail_threads SET triage_state = 'held' WHERE triage_state = 'review'`.pipe(
          Effect.asVoid,
        );
  const reviewCounts = sql<{ unreviewed: number; reviewing: number }>`SELECT
      (SELECT COUNT(*) FROM mail_threads WHERE triage_state = 'held' AND state = 'active')
        AS unreviewed,
      (SELECT COUNT(*) FROM mail_threads WHERE triage_state = 'review') AS reviewing`.pipe(
    Effect.map((rows) => ({
      unreviewed: num(rows[0]?.unreviewed),
      reviewing: num(rows[0]?.reviewing),
    })),
  );
  const requeueWaitingTriage = sql`UPDATE mail_threads SET triage_state = 'pending'
    WHERE triage_state IN ('waiting_model', 'capped')`.pipe(Effect.asVoid);

  /** Every unsettled thread, any with an unsent draft, and the newest settled ones. */
  const openThreads = (settledLimit: number) =>
    sql<Row>`SELECT * FROM (SELECT * FROM mail_threads WHERE state != 'settled' OR pinned_at IS NOT NULL
        OR id IN (SELECT thread_id FROM mail_drafts WHERE status IN ('draft', 'failed')))
      UNION ALL
      SELECT * FROM (SELECT * FROM mail_threads WHERE state = 'settled' AND pinned_at IS NULL
        AND id NOT IN (SELECT thread_id FROM mail_drafts WHERE status IN ('draft', 'failed'))
        ORDER BY last_message_at DESC, id DESC LIMIT ${settledLimit})`.pipe(
      Effect.map((rows) => rows.map(toThread)),
    );

  const labeledPage = (input: MailListLabeledInput) => {
    const date = input.mailbox === "sent" ? sql`last_outgoing_at` : sql`last_message_at`;
    const filters = {
      inbox: sql`AND (state = 'active' OR (pinned_at IS NOT NULL AND state != 'settled'))`,
      working: sql`AND state = 'working' AND pinned_at IS NULL`,
      snoozed: sql`AND state = 'snoozed' AND pinned_at IS NULL`,
      settled: sql`AND state = 'settled'`,
      sent: sql`AND last_outgoing_at IS NOT NULL`,
      drafts: sql`AND id IN (SELECT thread_id FROM mail_drafts WHERE status IN ('draft','failed'))`,
    };
    return sql<Row>`SELECT * FROM mail_threads WHERE account_id = ${input.scope.accountId}
      ${input.mailbox ? filters[input.mailbox] : sql``}
      ${
        input.query
          ? sql`AND EXISTS (SELECT 1 FROM mail_messages WHERE thread_id = mail_threads.id
        AND removed = 0 AND (instr(lower(subject), lower(${input.query})) OR instr(lower(from_name), lower(${input.query}))
          OR instr(lower(from_address), lower(${input.query})) OR instr(lower(body), lower(${input.query}))))`
          : sql``
      }
      AND id IN (${
        input.scope.kind === "label"
          ? sql`SELECT thread_id FROM mail_message_labels WHERE label = ${input.scope.name}`
          : sql`SELECT thread_id FROM mail_messages WHERE account_id = ${input.scope.accountId}
            AND mailbox = ${input.scope.name} AND removed = 0`
      })
      ${input.before ? sql`AND (${date},id) < (${input.before.at},${input.before.id})` : sql``}
      ORDER BY ${date} DESC,id DESC LIMIT ${(input.limit ?? 50) + 1}`.pipe(
      Effect.map((rows) => ({
        threads: rows.slice(0, input.limit ?? 50).map(toThread),
        hasMore: rows.length > (input.limit ?? 50),
      })),
    );
  };

  const settledPage = (input: {
    readonly before: { readonly at: string; readonly id: string } | undefined;
    readonly by: "ai" | "rule" | "user" | undefined;
    readonly limit: number;
  }) =>
    sql<Row>`SELECT * FROM mail_threads WHERE state = 'settled'
        ${input.before ? sql`AND (last_message_at, id) < (${input.before.at}, ${input.before.id})` : sql``}
        ${
          input.by === undefined
            ? sql``
            : input.by === "user"
              ? sql`AND settled_by NOT IN ('ai', 'rule')`
              : sql`AND settled_by = ${input.by}`
        }
      ORDER BY last_message_at DESC, id DESC LIMIT ${input.limit + 1}`.pipe(
      Effect.map((rows) => ({
        threads: rows.slice(0, input.limit).map(toThread),
        hasMore: rows.length > input.limit,
      })),
    );

  /** Threads the user wrote in, newest sent first. */
  const sentPage = (input: {
    readonly before: { readonly at: string; readonly id: string } | undefined;
    readonly limit: number;
  }) =>
    sql<Row>`SELECT * FROM mail_threads WHERE last_outgoing_at IS NOT NULL
        ${input.before ? sql`AND (last_outgoing_at, id) < (${input.before.at}, ${input.before.id})` : sql``}
      ORDER BY last_outgoing_at DESC, id DESC LIMIT ${input.limit + 1}`.pipe(
      Effect.map((rows) => ({
        threads: rows.slice(0, input.limit).map(toThread),
        hasMore: rows.length > input.limit,
      })),
    );

  /** Deletes or spam reports made here and not undone since `since`, newest first. */
  const trashPage = (input: {
    readonly kind: "delete" | "spam";
    readonly beforeId: number | undefined;
    readonly since: string;
    readonly limit: number;
  }) =>
    sql<Row>`SELECT * FROM mail_actions WHERE kind = ${input.kind} AND undone_at IS NULL
        AND (json_array_length(undo_json, '$.trash.messageIds') > 0
          OR json_array_length(undo_json, '$.trash.spam.copies') > 0) AND at >= ${input.since}
        ${input.beforeId === undefined ? sql`` : sql`AND id < ${input.beforeId}`}
      ORDER BY id DESC LIMIT ${input.limit + 1}`.pipe(
      Effect.map((rows) => ({
        actions: rows.slice(0, input.limit).map(toAction),
        hasMore: rows.length > input.limit,
      })),
    );

  /** A new email has no messages yet, so its row shows the draft's subject and recipient. */
  const setComposedHeader = (
    id: MailThreadId,
    header: {
      readonly subject: string;
      readonly fromName: string;
      readonly fromAddress: string;
      readonly at: string;
    },
  ) =>
    sql`UPDATE mail_threads SET subject = ${header.subject}, from_name = ${header.fromName},
        from_address = ${header.fromAddress}, last_message_at = ${header.at}
      WHERE id = ${id} AND message_count = 0`.pipe(Effect.asVoid);

  /** The new email (written here) that one of these Message-IDs belongs to, if any. */
  const findComposedThread = (accountId: MailAccountId, messageIds: ReadonlyArray<string>) =>
    messageIds.length === 0
      ? Effect.succeed(null)
      : sql<{ thread_id: string }>`SELECT thread_id FROM mail_messages
          WHERE account_id = ${accountId} AND message_id IN ${sql.in(messageIds)}
            AND instr(thread_id, ${`${accountId}:n:`}) = 1
          UNION ALL SELECT thread_id FROM mail_reset_messages
          WHERE account_id = ${accountId} AND message_id IN ${sql.in(messageIds)}
            AND instr(thread_id, ${`${accountId}:n:`}) = 1
          LIMIT 1`.pipe(
          Effect.map((rows) => (rows[0] ? MailThreadId.make(rows[0].thread_id) : null)),
        );

  const countSettled = sql<{
    count: number;
  }>`SELECT COUNT(*) AS count FROM mail_threads WHERE state = 'settled'`.pipe(
    Effect.map((rows) => num(rows[0]?.count)),
  );

  const dueSnoozes = (now: string) =>
    sql<Row>`SELECT * FROM mail_threads WHERE state = 'snoozed' AND snoozed_until IS NOT NULL
      AND snoozed_until <= ${now}`.pipe(Effect.map((rows) => rows.map(toThread)));

  const threadsByState = (state: MailThreadState, limit?: number) =>
    sql<Row>`SELECT * FROM mail_threads WHERE state = ${state}
      ${limit === undefined ? sql`` : sql`ORDER BY last_message_at DESC, id DESC LIMIT ${limit}`}`.pipe(
      Effect.map((rows) => rows.map(toThread)),
    );

  const repliedWaiting = (olderThan: string) =>
    sql<Row>`SELECT * FROM mail_threads WHERE nudge IS NULL AND last_outgoing_at IS NOT NULL
      AND last_outgoing_at = last_message_at AND last_outgoing_at <= ${olderThan}
      AND state = 'working' AND working_reason = 'waiting'`.pipe(
      Effect.map((rows) => rows.map(toThread)),
    );

  const relatedThreads = (
    accountId: MailAccountId,
    fromAddress: string,
    excludeId: MailThreadId,
    limit: number,
  ) =>
    sql<Row>`SELECT * FROM mail_threads WHERE account_id = ${accountId} AND from_address = ${fromAddress} AND id != ${excludeId}
      ORDER BY last_message_at DESC LIMIT ${limit}`.pipe(Effect.map((rows) => rows.map(toThread)));

  /** Messages whose Reply-To was never read, newest first. */
  const pendingReplyTo = (accountId: MailAccountId, mailbox: string, limit: number) =>
    sql<{ uid: number }>`SELECT uid FROM mail_messages WHERE account_id = ${accountId}
      AND mailbox = ${mailbox} AND removed = 0 AND outgoing = 0 AND reply_to_json IS NULL
      ORDER BY date DESC LIMIT ${limit}`.pipe(
      Effect.map((rows) => rows.map((row) => num(row.uid))),
    );
  const setReplyTo = Effect.fn("MailStore.setReplyTo")(function* (
    accountId: MailAccountId,
    mailbox: string,
    found: ReadonlyArray<{ readonly uid: number; readonly replyTo: ReadonlyArray<MailAddress> }>,
    asked: ReadonlyArray<number>,
  ) {
    const byUid = new Map(found.map((entry) => [entry.uid, entry.replyTo]));
    // A UID the server no longer has gets an empty list, so it is not asked for again.
    yield* sql.withTransaction(
      Effect.forEach(
        asked,
        (uid) =>
          sql`UPDATE mail_messages SET reply_to_json = ${toJson(byUid.get(uid) ?? [])}
            WHERE account_id = ${accountId} AND mailbox = ${mailbox} AND uid = ${uid}
              AND reply_to_json IS NULL`,
        { discard: true },
      ),
    );
  });

  const latestMessage = (threadId: MailThreadId, incomingOnly = false) =>
    sql<Row>`SELECT * FROM mail_messages WHERE thread_id = ${threadId} AND removed = 0
      ${incomingOnly ? sql`AND outgoing = 0` : sql``} ORDER BY date DESC, id DESC LIMIT 1`.pipe(
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
  const trustClock = (key: string) =>
    sql<TrustClock>`SELECT revision, setting, reset FROM mail_trust_clock WHERE key = ${key}`.pipe(
      Effect.map((rows) => rows[0] ?? { revision: 0, setting: 0, reset: 0 }),
    );
  const advanceTrustClock = (key: string) =>
    sql<TrustClock>`INSERT INTO mail_trust_clock(key, revision, setting, reset)
      VALUES (${key}, 1, 0, 0)
      ON CONFLICT(key) DO UPDATE SET revision = revision + 1, setting = setting + excluded.setting,
        reset = reset + excluded.reset RETURNING revision, setting, reset`.pipe(
      Effect.map((rows) => rows[0]!),
    );
  const putTrust = (record: TrustRecord, now: string) =>
    sql`INSERT INTO mail_trust (key, kind, reason, approvals, rejections, updated_at)
      VALUES (${record.key}, ${record.kind}, ${record.reason}, ${record.approvals},
        ${record.rejections}, ${now})
      ON CONFLICT (key) DO UPDATE SET reason = excluded.reason, approvals = excluded.approvals,
        rejections = excluded.rejections, updated_at = excluded.updated_at`.pipe(Effect.asVoid);
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
    readonly includeSpamAndUnsubscribe?: boolean | undefined;
    readonly beforeId: number | undefined;
    readonly actor: MailActor | undefined;
    readonly automatic?: boolean | undefined;
    readonly threadId: MailThreadId | undefined;
    readonly limit: number;
  }) =>
    sql<Row>`SELECT * FROM mail_action_history WHERE 1 = 1
        ${input.includeSpamAndUnsubscribe === false ? sql`AND kind NOT IN ('spam', 'unsubscribe')` : sql``}
        ${input.beforeId === undefined ? sql`` : sql`AND id < ${input.beforeId}`}
        ${input.actor === undefined ? sql`` : sql`AND actor = ${input.actor}`}
        ${input.automatic ? sql`AND (actor = 'rule' OR (actor = 'mail' AND kind = 'delete' AND reason = 'sign_in_code'))` : sql``}
        ${input.threadId === undefined ? sql`` : sql`AND thread_id = ${input.threadId}`}
      ORDER BY id DESC LIMIT ${input.limit + 1}`.pipe(
      Effect.map((rows) => ({
        actions: rows.slice(0, input.limit).map(toAction),
        hasMore: rows.length > input.limit,
      })),
    );
  /** The day's counts and the newest automatic settles that still stand, one per thread. */
  const recapSince = Effect.fn("MailStore.recapSince")(function* (since: string, limit: number) {
    const [counts] = yield* sql<Row>`SELECT
        (SELECT COUNT(*) FROM mail_actions WHERE at >= ${since} AND undone_at IS NULL) AS actions,
        (SELECT COUNT(*) FROM mail_actions WHERE at >= ${since} AND undone_at IS NULL
          AND kind = 'settle' AND actor IN ('ai', 'rule')) AS settled_by_ai,
        (SELECT COUNT(*) FROM mail_actions WHERE at >= ${since} AND undone_at IS NULL
          AND kind = 'settle' AND actor NOT IN ('ai', 'rule')) AS settled_by_you,
        (SELECT COUNT(*) FROM mail_threads WHERE last_incoming_at >= ${since}) AS arrived,
        (SELECT COUNT(*) FROM mail_threads WHERE state = 'active') AS needs_you`;
    const rows = yield* sql<Row>`WITH latest AS (
        SELECT MAX(id) AS id FROM mail_actions
        WHERE at >= ${since} AND undone_at IS NULL AND kind = 'settle'
          AND actor IN ('ai', 'rule') AND thread_id IS NOT NULL
        GROUP BY thread_id
      )
      SELECT action.id AS action_id, action.actor AS action_actor, COUNT(*) OVER () AS total, thread.*
      FROM latest
      JOIN mail_actions AS action ON action.id = latest.id
      JOIN mail_threads AS thread ON thread.id = action.thread_id
      WHERE thread.state = 'settled' AND thread.settled_by = action.actor
      ORDER BY action.id DESC LIMIT ${limit}`;
    const senders = yield* sql<{ name: string }>`SELECT
        COALESCE(NULLIF(thread.from_name, ''), thread.from_address) AS name
      FROM mail_actions AS action JOIN mail_threads AS thread ON thread.id = action.thread_id
      WHERE action.at >= ${since} AND action.undone_at IS NULL AND action.kind = 'settle'
        AND action.actor IN ('ai', 'rule')
      GROUP BY name ORDER BY COUNT(*) DESC LIMIT 3`;
    return {
      actions: num(counts?.actions),
      settledByAi: num(counts?.settled_by_ai),
      settledByYou: num(counts?.settled_by_you),
      arrived: num(counts?.arrived),
      needsYou: num(counts?.needs_you),
      topAiSenders: senders.map((row) => row.name),
      total: num(rows[0]?.total),
      settled: rows.map((row) => ({
        actionId: num(row.action_id),
        actor: str(row.action_actor) as MailActor,
        thread: toThread(row),
      })),
    };
  });

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
  const rowsWithDrafts = Effect.fn("MailStore.rowsWithDrafts")(function* (
    threads: ReadonlyArray<ThreadRecord>,
  ) {
    const drafts = yield* threadsWithDrafts(threads.map((thread) => thread.id));
    return threads.map((thread) => threadRow(thread, drafts.has(thread.id)));
  });
  const threadLabels = (threadId: MailThreadId) =>
    sql<{
      label: string;
    }>`SELECT DISTINCT label FROM mail_message_labels WHERE thread_id = ${threadId} ORDER BY label`.pipe(
      Effect.map((rows) => rows.map((row) => row.label)),
    );
  const getDraft = (id: MailDraftId) =>
    sql<Row>`SELECT * FROM mail_drafts WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] ? toDraft(rows[0]) : null)),
    );
  /** Saves an edit. Every save bumps the revision, so a send approves exactly one version. */
  const saveDraftContent = (draft: DraftRecord) =>
    sql<Row>`INSERT INTO mail_drafts (id, thread_id, account_id, to_json, cc_json, bcc_json,
        files_json, subject, body, origin, original_body, status, error, message_id, revision,
        updated_at, sent_at, mode, target_message)
      VALUES (${draft.id}, ${draft.threadId}, ${draft.accountId}, ${toJson(draft.to)},
        ${toJson(draft.cc)}, ${toJson(draft.bcc)}, ${toJson(draft.files)},
        ${draft.subject}, ${draft.body}, ${draft.origin},
        ${draft.originalBody}, ${draft.status}, ${draft.error}, ${draft.messageId}, ${draft.revision},
        ${draft.updatedAt}, NULL, ${draft.mode},
        ${draft.targetMessageId === null ? null : Number(draft.targetMessageId)})
      ON CONFLICT (id) DO UPDATE SET to_json = excluded.to_json, cc_json = excluded.cc_json,
        bcc_json = excluded.bcc_json, files_json = excluded.files_json, mode = excluded.mode, target_message = excluded.target_message,
        subject = excluded.subject, body = excluded.body, status = excluded.status, error = excluded.error,
        message_id = excluded.message_id, revision = mail_drafts.revision + 1, updated_at = excluded.updated_at
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
      readonly editSender?: string | null;
      readonly remaining?:
        | {
            readonly to: ReadonlyArray<string>;
            readonly cc: ReadonlyArray<string>;
            readonly bcc: ReadonlyArray<string>;
          }
        | undefined;
    },
  ) =>
    sql<Row>`UPDATE mail_drafts SET status = ${result.status}, error = ${result.error},
        ${
          result.remaining
            ? sql`to_json = ${toJson(result.remaining.to)}, cc_json = ${toJson(result.remaining.cc)},
          bcc_json = ${toJson(result.remaining.bcc)}, message_id = NULL, revision = revision + 1,`
            : sql``
        }
        updated_at = ${result.at}, sent_at = ${result.status === "sent" ? result.at : null},
        edit_sender = ${result.editSender ?? null}
      WHERE id = ${id} AND status = 'sending' RETURNING *`.pipe(
      Effect.map((rows) => (rows[0] ? toDraft(rows[0]) : null)),
    );
  const recentReplyEdits = (accountId: MailAccountId, sender: string) =>
    sql<{ before: string; after: string }>`SELECT substr(original_body, 1, 600) AS before,
        substr(body, 1, 600) AS after FROM mail_drafts
      WHERE account_id = ${accountId} AND edit_sender = ${sender}
      ORDER BY sent_at DESC, rowid DESC LIMIT 3`;
  /** A send cut off by a crash or restart may or may not have reached the server. */
  const recoverInterruptedSends = (now: string, error: string) =>
    sql`UPDATE mail_drafts SET status = 'failed', error = ${error}, updated_at = ${now}
      WHERE status = 'sending'`.pipe(Effect.asVoid);
  const deleteEmptyThreads = (
    candidates: Statement.Fragment,
    otherMailboxes: Statement.Fragment = sql``,
  ) =>
    sql<{ id: string }>`DELETE FROM mail_threads WHERE id IN ${candidates}
        AND NOT EXISTS (SELECT 1 FROM mail_messages
          WHERE mail_messages.thread_id = mail_threads.id AND mail_messages.removed = 0)
        AND NOT EXISTS (SELECT 1 FROM mail_reset_messages
          WHERE thread_id = mail_threads.id ${otherMailboxes})
      RETURNING id`.pipe(Effect.map((rows) => rows.map((row) => MailThreadId.make(row.id))));

  const deleteExpungedThreads = (ids: ReadonlyArray<MailThreadId>) =>
    ids.length === 0 ? Effect.succeed([]) : deleteEmptyThreads(sql`${sql.in(ids)}`);

  const finishMailboxReset = (accountId: MailAccountId, mailbox: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const candidates = sql`(SELECT thread_id FROM mail_reset_messages
        WHERE account_id = ${accountId} AND mailbox = ${mailbox})`;
        const removed = yield* deleteEmptyThreads(candidates, sql`AND mailbox <> ${mailbox}`);
        yield* sql`DELETE FROM mail_reset_messages WHERE account_id = ${accountId} AND mailbox = ${mailbox}`;
        return removed;
      }),
    );

  const deleteDraft = (id: MailDraftId) =>
    sql`DELETE FROM mail_drafts WHERE id = ${id} AND status != 'sending'`.pipe(Effect.asVoid);

  const insertDraftFile = (
    file: MailDraftFile & { readonly accountId: MailAccountId; readonly content: Uint8Array },
    at: string,
  ) =>
    sql`INSERT INTO mail_draft_files (id, account_id, filename, content_type, size, content, created_at)
      VALUES (${file.id}, ${file.accountId}, ${file.filename}, ${file.contentType}, ${file.size},
        ${file.content}, ${at})`.pipe(Effect.asVoid);
  /** The files among `ids` this account uploaded that are still kept. */
  const draftFiles = (accountId: MailAccountId, ids: ReadonlyArray<string>) =>
    ids.length === 0
      ? Effect.succeed(new Map<string, MailDraftFile>())
      : sql<Row>`SELECT id, filename, content_type, size FROM mail_draft_files
          WHERE account_id = ${accountId} AND id IN ${sql.in(ids)}`.pipe(
          Effect.map(
            (rows) =>
              new Map(
                rows.map((row): [string, MailDraftFile] => [
                  str(row.id),
                  {
                    id: str(row.id),
                    filename: str(row.filename),
                    contentType: str(row.content_type),
                    size: num(row.size),
                  },
                ]),
              ),
          ),
        );
  const draftFileContents = (accountId: MailAccountId, ids: ReadonlyArray<string>) =>
    ids.length === 0
      ? Effect.succeed(new Map<string, Uint8Array>())
      : sql<{ id: string; content: Uint8Array }>`SELECT id, content FROM mail_draft_files
          WHERE account_id = ${accountId} AND id IN ${sql.in(ids)}`.pipe(
          Effect.map((rows) => new Map(rows.map((row) => [row.id, row.content]))),
        );
  // Discarding a draft removes its row, but Undo can still restore the files named in its history.
  const retainedFileIds = sql`(
    SELECT json_extract(f.value, '$.id') FROM mail_drafts d, json_each(d.files_json) f
      WHERE d.status IN ('draft', 'failed', 'sending')
    UNION ALL
    SELECT json_extract(f.value, '$.id') FROM mail_actions a, json_each(a.undo_json, '$.discardedDraft.files') f
      WHERE a.kind = 'draft' AND a.undone_at IS NULL
    UNION ALL
    SELECT json_extract(f.value, '$.id') FROM mail_action_history a, json_each(a.undo_json, '$.draft.before.files') f
      WHERE a.kind = 'draft' AND a.undone_at IS NULL
  )`;
  const releaseDraftFiles = (draftId: MailDraftId) =>
    sql`DELETE FROM mail_draft_files WHERE id IN (SELECT json_extract(f.value, '$.id')
        FROM mail_drafts d, json_each(d.files_json) f WHERE d.id = ${draftId})
      AND id NOT IN ${retainedFileIds}`.pipe(Effect.asVoid);
  const pruneDraftFiles = (before: string) =>
    sql`DELETE FROM mail_draft_files WHERE created_at < ${before}
      AND id NOT IN ${retainedFileIds}`.pipe(Effect.asVoid);

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
    nextLocalSentUid,
    listAccounts,
    getAccount,
    insertAccount,
    updateAccount,
    setLabelCatalog,
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
    pendingDisplayBodies,
    updateFlags,
    markRemoved,
    moveMessage,
    knownUids,
    knownUidsAmong,
    threadMessages,
    messageTargets,
    mirrorTargets,
    getThread,
    getThreads,
    getChatMail,
    addTriageNote,
    latestTriageNote,
    unpublishedTriageNotes,
    markTriageNotePublished,
    insertThread,
    refreshThreadAggregate,
    patchThread,
    patchForAction,
    refreshUnread,
    markMessagesRead,
    undoMessagesRead,
    pendingReplyTo,
    setReplyTo,
    markNewestUnread,
    undoMessagesUnread,
    serverLocations,
    spamSources,
    removeMessages,
    removeThread,
    setTriage,
    setChatThread,
    pendingTriage,
    requeueWaitingTriage,
    openThreads,
    labeledPage,
    settledPage,
    sentPage,
    trashPage,
    setComposedHeader,
    findComposedThread,
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
    listTrust,
    trustClock,
    advanceTrustClock,
    insertAction,
    getAction,
    markActionUndone,
    listActions,
    recapSince,
    setReview,
    reviewCounts,
    draftsForThread,
    rowsWithDrafts,
    threadLabels,
    getDraft,
    deleteExpungedThreads,
    finishMailboxReset,
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => sql.withTransaction(effect),
    saveDraftContent,
    claimDraftForSend,
    finishDraftSend,
    recentReplyEdits,
    recoverInterruptedSends,
    deleteDraft,
    insertDraftFile,
    draftFiles,
    draftFileContents,
    releaseDraftFiles,
    pruneDraftFiles,
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
