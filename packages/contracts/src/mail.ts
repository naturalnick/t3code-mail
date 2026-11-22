import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { UsageDay } from "./usage.ts";
import { ModelSelection } from "./modelSelection.ts";

/** The project that holds mail chat sessions. Fixed, so every client can keep it out of the coding views. */
export const MAIL_SESSION_PROJECT_ID = ProjectId.make("t3-mail-sessions");

export const MailAccountId = TrimmedNonEmptyString.pipe(Schema.brand("MailAccountId"));
export type MailAccountId = typeof MailAccountId.Type;
export const MailThreadId = TrimmedNonEmptyString.pipe(Schema.brand("MailThreadId"));
export type MailThreadId = typeof MailThreadId.Type;
export const MailDraftId = TrimmedNonEmptyString.pipe(Schema.brand("MailDraftId"));
export type MailDraftId = typeof MailDraftId.Type;

/** Sidebar states, named like the coding sidebar's sections. Pinned is a flag on top of these. */
export const MailThreadState = Schema.Literals(["active", "working", "snoozed", "settled"]);
export type MailThreadState = typeof MailThreadState.Type;

/** Why a thread was settled. FYI and noise are reasons, not buckets. */
export const MailSettleReason = Schema.Literals([
  "fyi",
  "receipt",
  "noise",
  "replied",
  "done",
  "archived",
]);
export type MailSettleReason = typeof MailSettleReason.Type;

export const MailActor = Schema.Literals(["user", "ai", "rule", "agent", "mail"]);
export type MailActor = typeof MailActor.Type;

export const MailCategory = Schema.Literals([
  "person",
  "newsletter",
  "promotion",
  "notification",
  "receipt",
  "invoice",
  "otp",
  "delivery",
  "security",
  "legal",
  "calendar",
  "social",
  "other",
]);
export type MailCategory = typeof MailCategory.Type;

export const MailGuardrail = Schema.Literals([
  "replied_to",
  "urgent",
  "money",
  "security",
  "legal",
]);
export type MailGuardrail = typeof MailGuardrail.Type;

export const MailWorkingReason = Schema.Literals(["drafting", "waiting"]);
export type MailWorkingReason = typeof MailWorkingReason.Type;

export const MailAddress = Schema.Struct({
  name: Schema.String,
  address: Schema.String,
});
export type MailAddress = typeof MailAddress.Type;

export const MailSuggestion = Schema.Struct({
  revision: Schema.String,
  reason: MailSettleReason,
  confidence: Schema.Number,
});
export type MailSuggestion = typeof MailSuggestion.Type;

export const MailThreadRow = Schema.Struct({
  id: MailThreadId,
  accountId: MailAccountId,
  subject: Schema.String,
  from: MailAddress,
  suggestedAction: Schema.NullOr(Schema.String),
  lastMessageAt: IsoDateTime,
  messageCount: NonNegativeInt,
  unread: Schema.Boolean,
  state: MailThreadState,
  /** When the thread entered its current state. */
  stateAt: IsoDateTime,
  pinnedAt: Schema.NullOr(IsoDateTime),
  workingReason: Schema.NullOr(MailWorkingReason),
  settledReason: Schema.NullOr(MailSettleReason),
  settledBy: Schema.NullOr(MailActor),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozeOnReply: Schema.Boolean,
  /** A pending "settle?" proposal while the sender or category is in suggest mode. */
  suggestion: Schema.NullOr(MailSuggestion),
  category: Schema.NullOr(MailCategory),
  guardrail: Schema.NullOr(MailGuardrail),
  nudge: Schema.NullOr(Schema.String),
  hasDraft: Schema.Boolean,
  chatThreadId: Schema.NullOr(ThreadId),
  /** The latest message reads like instructions to an AI. It is still treated as data. */
  injectionWarning: Schema.Boolean,
  triagePending: Schema.Boolean,
});
export type MailThreadRow = typeof MailThreadRow.Type;

export const MailAttachment = Schema.Struct({
  filename: Schema.String,
  contentType: Schema.String,
  size: NonNegativeInt,
});
export type MailAttachment = typeof MailAttachment.Type;

export const MailFormattedBody = Schema.Struct({
  html: Schema.String,
  inlineImages: Schema.Record(Schema.String, Schema.String),
});
export type MailFormattedBody = typeof MailFormattedBody.Type;

export const MailMessageBodyInput = Schema.Struct({
  threadId: MailThreadId,
  messageId: NonNegativeInt,
});
export type MailMessageBodyInput = typeof MailMessageBodyInput.Type;

export const MailMessage = Schema.Struct({
  id: Schema.String,
  from: MailAddress,
  /** Where the sender asks replies to go. Empty when unknown; reply to `from` then. */
  replyTo: Schema.Array(MailAddress).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  to: Schema.Array(MailAddress),
  cc: Schema.Array(MailAddress),
  date: IsoDateTime,
  subject: Schema.String,
  /** Cleaned text: no HTML, tracking junk, signature or quoted chain. */
  text: Schema.NullOr(Schema.String),
  /** Text with quotes and signature kept. */
  fullText: Schema.NullOr(Schema.String),
  attachments: Schema.Array(MailAttachment),
  outgoing: Schema.Boolean,
  unread: Schema.Boolean,
});
export type MailMessage = typeof MailMessage.Type;

export const MailDraftStatus = Schema.Literals(["draft", "sending", "sent", "failed"]);
export type MailDraftStatus = typeof MailDraftStatus.Type;

/** A forward carries the message and its attachments; a reply quotes it. */
export const MailDraftMode = Schema.Literals(["reply", "forward"]);
export type MailDraftMode = typeof MailDraftMode.Type;

export const MailDraft = Schema.Struct({
  id: MailDraftId,
  threadId: MailThreadId,
  accountId: MailAccountId,
  to: Schema.Array(Schema.String),
  cc: Schema.Array(Schema.String),
  subject: Schema.String,
  body: Schema.String,
  origin: MailActor,
  status: MailDraftStatus,
  error: Schema.NullOr(Schema.String),
  /** Bumped by every save. Sending names the revision the user reviewed. */
  revision: NonNegativeInt,
  mode: MailDraftMode.pipe(Schema.withDecodingDefaultKey(Effect.succeed("reply" as const))),
  /** The message this answers or forwards; null on older drafts, sent as written. */
  targetMessageId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  updatedAt: IsoDateTime,
  sentAt: Schema.NullOr(IsoDateTime),
});
export type MailDraft = typeof MailDraft.Type;

export const MailActionKind = Schema.Literals([
  "settle",
  "unsettle",
  "pin",
  "unpin",
  "snooze",
  "unsnooze",
  "approve",
  "reject",
  "never_show",
  "draft",
  "send",
  "trust",
  "returned",
  "mark_read",
  "mark_unread",
  "delete",
  "wait_for_reply",
  "nudge",
  "propose",
]);
export type MailActionKind = typeof MailActionKind.Type;

export const MailActionEntry = Schema.Struct({
  id: NonNegativeInt,
  at: IsoDateTime,
  actor: MailActor,
  actorLabel: Schema.NullOr(Schema.String),
  kind: MailActionKind,
  threadId: Schema.NullOr(MailThreadId),
  subject: Schema.NullOr(Schema.String),
  from: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  undoable: Schema.Boolean,
  undoneAt: Schema.NullOr(IsoDateTime),
});
export type MailActionEntry = typeof MailActionEntry.Type;

export const MailThreadDetail = Schema.Struct({
  thread: MailThreadRow,
  messages: Schema.Array(MailMessage),
  drafts: Schema.Array(MailDraft),
  /** Recent other threads with the same sender. */
  related: Schema.Array(
    Schema.Struct({
      id: MailThreadId,
      subject: Schema.String,
      lastMessageAt: IsoDateTime,
      state: MailThreadState,
    }),
  ),
  actions: Schema.Array(MailActionEntry),
  verdict: Schema.NullOr(
    Schema.Struct({
      decision: Schema.Literals(["settle", "keep"]),
      reason: Schema.String,
      confidence: Schema.Number,
      source: Schema.Literals(["rule", "memory", "model", "escalated"]),
    }),
  ),
});
export type MailThreadDetail = typeof MailThreadDetail.Type;

export const MailProviderKind = Schema.Literals(["gmail", "imap"]);
export type MailProviderKind = typeof MailProviderKind.Type;

export const MailAccountStatus = Schema.Literals([
  "connecting",
  "syncing",
  "idle",
  "paused",
  "auth_failed",
  "error",
  "offline",
]);
export type MailAccountStatus = typeof MailAccountStatus.Type;

export const MailAccount = Schema.Struct({
  id: MailAccountId,
  email: Schema.String,
  displayName: Schema.String,
  provider: MailProviderKind,
  imapHost: Schema.String,
  imapPort: NonNegativeInt,
  smtpHost: Schema.String,
  smtpPort: NonNegativeInt,
  status: MailAccountStatus,
  /** Server-authored English detail for errors, such as the IMAP server's own message. */
  statusDetail: Schema.NullOr(Schema.String),
  lastSyncAt: Schema.NullOr(IsoDateTime),
  messageCount: NonNegativeInt,
  backfillDone: Schema.Boolean,
  /** Gmail's download cap paused the backfill; new mail still syncs. */
  backfillPausedUntil: Schema.NullOr(IsoDateTime),
  credentialStore: Schema.Literals(["keychain", "file"]),
});
export type MailAccount = typeof MailAccount.Type;

export const MailRuleAction = Schema.Literals(["settle", "keep", "never_show"]);
export type MailRuleAction = typeof MailRuleAction.Type;

export const MailRule = Schema.Struct({
  id: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  match: Schema.Struct({
    from: Schema.optionalKey(TrimmedString),
    domain: Schema.optionalKey(TrimmedString),
    subjectContains: Schema.optionalKey(TrimmedString),
    listId: Schema.optionalKey(TrimmedString),
  }),
  action: MailRuleAction,
  reason: MailSettleReason,
});
export type MailRule = typeof MailRule.Type;

export const MailSettings = Schema.Struct({
  defaultModelSelection: Schema.NullOr(ModelSelection),
  /** A smarter model for low-confidence verdicts and senders who matter. Null keeps them as suggestions. */
  escalationModelSelection: Schema.NullOr(ModelSelection),
  trustThreshold: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
  /** Estimated tokens per week. Null means no cap. */
  weeklyTokenCap: Schema.NullOr(NonNegativeInt),
  serverMirroring: Schema.Boolean,
  recapEnabled: Schema.Boolean,
  notificationsEnabled: Schema.Boolean,
  nudgeReplyDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  nudgeWaitingDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  syncEnabled: Schema.Boolean,
  rules: Schema.Array(MailRule),
});
export type MailSettings = typeof MailSettings.Type;

export const MailTrustLevel = Schema.Literals(["suggest", "auto", "never"]);
export type MailTrustLevel = typeof MailTrustLevel.Type;

export const MailTrustRecord = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["sender", "category"]),
  label: Schema.String,
  reason: Schema.NullOr(MailSettleReason),
  approvals: NonNegativeInt,
  rejections: NonNegativeInt,
  streak: NonNegativeInt,
  trust: MailTrustLevel,
  /** The user set this level by hand, which also lifts guardrails for an auto sender. */
  explicit: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type MailTrustRecord = typeof MailTrustRecord.Type;

export const MailUsage = Schema.Struct({
  weekStart: IsoDateTime,
  providerWindow: Schema.optional(
    Schema.Struct({
      sinceDay: UsageDay,
      untilDay: UsageDay,
      timeZone: TrimmedNonEmptyString,
    }),
  ),
  tokens: NonNegativeInt,
  /** Text-generation estimates included in tokens alongside reported mail chat usage. */
  estimatedTokens: Schema.optional(NonNegativeInt),
  calls: NonNegativeInt,
  emails: NonNegativeInt,
  cap: Schema.NullOr(NonNegativeInt),
  capped: Schema.Boolean,
  /** Older clients require this field. Settings reads provider totals through the diagnostics-scoped usage RPC. */
  providerTokens: Schema.NullOr(NonNegativeInt),
});
export type MailUsage = typeof MailUsage.Type;

export const MailRecap = Schema.Struct({
  date: TrimmedNonEmptyString,
  arrived: NonNegativeInt,
  settledByAi: NonNegativeInt,
  settledByYou: NonNegativeInt,
  needsYou: NonNegativeInt,
  topAiSenders: Schema.Array(Schema.String),
});
export type MailRecap = typeof MailRecap.Type;

export const MailStatus = Schema.Struct({
  accounts: Schema.Array(MailAccount),
  settings: MailSettings,
  usage: MailUsage,
  /** Today's recap until the user dismisses it. */
  recap: Schema.NullOr(MailRecap),
  sessionProjectId: Schema.NullOr(ProjectId),
  emailMdPath: Schema.String,
  settledCount: NonNegativeInt,
});
export type MailStatus = typeof MailStatus.Type;

export const MailStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    status: MailStatus,
    /** Every unsettled thread, plus the most recent settled ones. */
    threads: Schema.Array(MailThreadRow),
  }),
  Schema.Struct({
    type: Schema.Literal("threads"),
    upserted: Schema.Array(MailThreadRow),
    removed: Schema.Array(MailThreadId),
  }),
  Schema.Struct({ type: Schema.Literal("status"), status: MailStatus }),
]);
export type MailStreamEvent = typeof MailStreamEvent.Type;

export const MailErrorCode = Schema.Literals([
  "not_found",
  "invalid",
  "auth_failed",
  "connection_failed",
  "unavailable",
  "send_failed",
]);
export type MailErrorCode = typeof MailErrorCode.Type;

export class MailError extends Schema.TaggedError<MailError>()("MailError", {
  code: MailErrorCode,
  message: Schema.String,
}) {}

export const MailThreadInput = Schema.Struct({ threadId: MailThreadId });

export const MailListSettledInput = Schema.Struct({
  before: Schema.optionalKey(Schema.Struct({ at: IsoDateTime, id: MailThreadId })),
  reason: Schema.optionalKey(MailSettleReason),
  byAi: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export const MailThreadPage = Schema.Struct({
  threads: Schema.Array(MailThreadRow),
  hasMore: Schema.Boolean,
});

export const MailSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString,
  /** Also ask Gmail (X-GM-RAW) for matches not synced yet. */
  server: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export const MailSearchResult = Schema.Struct({
  threads: Schema.Array(MailThreadRow),
  serverMatches: NonNegativeInt,
});

export const MailThreadAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("settle"), reason: Schema.optionalKey(MailSettleReason) }),
  Schema.Struct({ type: Schema.Literal("unsettle") }),
  Schema.Struct({ type: Schema.Literal("pin") }),
  Schema.Struct({ type: Schema.Literal("unpin") }),
  Schema.Struct({
    type: Schema.Literal("snooze"),
    until: Schema.NullOr(IsoDateTime),
    onReply: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("unsnooze") }),
  /** Accept the AI's settle proposal. Counts toward graduation. */
  Schema.Struct({
    type: Schema.Literal("approve"),
    revisions: Schema.Record(Schema.String, Schema.String),
  }),
  /** "Keep in Active": refuse the proposal or an AI settle. Demotes the sender and category. */
  Schema.Struct({ type: Schema.Literal("keep") }),
  Schema.Struct({ type: Schema.Literal("never_show") }),
  Schema.Struct({ type: Schema.Literal("mark_read") }),
  /** The newest incoming message becomes unread again. */
  Schema.Struct({ type: Schema.Literal("mark_unread") }),
  /** Moves every message to the mail server's Trash and removes the email here. */
  Schema.Struct({ type: Schema.Literal("delete") }),
  Schema.Struct({ type: Schema.Literal("wait_for_reply") }),
]);
export type MailThreadAction = typeof MailThreadAction.Type;

export const MailActInput = Schema.Struct({
  threadIds: Schema.Array(MailThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  action: MailThreadAction,
});
export const MailActResult = Schema.Struct({ actionIds: Schema.Array(NonNegativeInt) });

export const MailUndoInput = Schema.Struct({ actionId: NonNegativeInt });

export const MailListActionsInput = Schema.Struct({
  beforeId: Schema.optionalKey(NonNegativeInt),
  actor: Schema.optionalKey(MailActor),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export const MailActionPage = Schema.Struct({
  actions: Schema.Array(MailActionEntry),
  hasMore: Schema.Boolean,
});

export const MailSaveDraftInput = Schema.Struct({
  threadId: MailThreadId,
  draftId: Schema.optionalKey(MailDraftId),
  expectedRevision: Schema.optionalKey(NonNegativeInt),
  to: Schema.Array(Schema.String),
  cc: Schema.Array(Schema.String),
  subject: Schema.String,
  body: Schema.String,
  mode: Schema.optionalKey(MailDraftMode),
  targetMessageId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export const MailDraftInput = Schema.Struct({
  draftId: MailDraftId,
  expectedRevision: Schema.optionalKey(NonNegativeInt),
});
export const MailSendDraftInput = Schema.Struct({
  draftId: MailDraftId,
  /** The revision the user reviewed; the send is refused if the draft changed since. */
  revision: NonNegativeInt,
});

export const MailOpenSessionInput = Schema.Struct({
  threadId: MailThreadId,
  prompt: Schema.optionalKey(TrimmedNonEmptyString),
  modelSelection: Schema.optionalKey(ModelSelection),
});
export const MailOpenSessionResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  created: Schema.Boolean,
});

export const MailAccountConnection = Schema.Struct({
  imapHost: TrimmedNonEmptyString,
  imapPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  imapTls: Schema.Boolean,
  smtpHost: TrimmedNonEmptyString,
  smtpPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  smtpTls: Schema.Boolean,
  username: TrimmedNonEmptyString,
});
export type MailAccountConnection = typeof MailAccountConnection.Type;

export const MailAddAccountInput = Schema.Struct({
  email: TrimmedNonEmptyString,
  displayName: Schema.optionalKey(TrimmedString),
  appPassword: Schema.String.check(Schema.isMinLength(1)),
  /** Omitted for Gmail and providers whose settings are known from the address. */
  connection: Schema.optionalKey(MailAccountConnection),
});
export const MailUpdateAccountInput = Schema.Struct({
  accountId: MailAccountId,
  appPassword: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  displayName: Schema.optionalKey(TrimmedString),
});
export const MailAccountInput = Schema.Struct({ accountId: MailAccountId });
export const MailSyncInput = Schema.Struct({ accountId: Schema.optionalKey(MailAccountId) });

export const MailUpdateSettingsInput = Schema.Struct({
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  escalationModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  trustThreshold: Schema.optionalKey(MailSettings.fields.trustThreshold),
  weeklyTokenCap: Schema.optionalKey(MailSettings.fields.weeklyTokenCap),
  serverMirroring: Schema.optionalKey(Schema.Boolean),
  recapEnabled: Schema.optionalKey(Schema.Boolean),
  notificationsEnabled: Schema.optionalKey(Schema.Boolean),
  nudgeReplyDays: Schema.optionalKey(MailSettings.fields.nudgeReplyDays),
  nudgeWaitingDays: Schema.optionalKey(MailSettings.fields.nudgeWaitingDays),
  syncEnabled: Schema.optionalKey(Schema.Boolean),
  rules: Schema.optionalKey(Schema.Array(MailRule)),
});

export const MailTrustList = Schema.Struct({ records: Schema.Array(MailTrustRecord) });
export const MailSetTrustInput = Schema.Struct({
  key: TrimmedNonEmptyString,
  trust: Schema.Literals(["suggest", "auto", "never", "reset"]),
});

export const MailEmailMd = Schema.Struct({ path: Schema.String, content: Schema.String });
export const MailWriteEmailMdInput = Schema.Struct({ content: Schema.String });

export const MailDryRunRuleInput = Schema.Struct({ rule: MailRule });
export const MailDryRunRuleResult = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      threadId: MailThreadId,
      subject: Schema.String,
      from: Schema.String,
      state: MailThreadState,
    }),
  ),
  total: NonNegativeInt,
});

export const MailSeedVoiceResult = Schema.Struct({ notes: Schema.String });
export const MailDismissRecapInput = Schema.Struct({ date: TrimmedNonEmptyString });

export type MailThreadInput = typeof MailThreadInput.Type;
export type MailListSettledInput = typeof MailListSettledInput.Type;
export type MailThreadPage = typeof MailThreadPage.Type;
export type MailSearchInput = typeof MailSearchInput.Type;
export type MailSearchResult = typeof MailSearchResult.Type;
export type MailActInput = typeof MailActInput.Type;
export type MailActResult = typeof MailActResult.Type;
export type MailUndoInput = typeof MailUndoInput.Type;
export type MailListActionsInput = typeof MailListActionsInput.Type;
export type MailActionPage = typeof MailActionPage.Type;
export type MailSaveDraftInput = typeof MailSaveDraftInput.Type;
export type MailDraftInput = typeof MailDraftInput.Type;
export type MailSendDraftInput = typeof MailSendDraftInput.Type;
export type MailOpenSessionInput = typeof MailOpenSessionInput.Type;
export type MailOpenSessionResult = typeof MailOpenSessionResult.Type;
export type MailAddAccountInput = typeof MailAddAccountInput.Type;
export type MailUpdateAccountInput = typeof MailUpdateAccountInput.Type;
export type MailAccountInput = typeof MailAccountInput.Type;
export type MailSyncInput = typeof MailSyncInput.Type;
export type MailUpdateSettingsInput = typeof MailUpdateSettingsInput.Type;
export type MailTrustList = typeof MailTrustList.Type;
export type MailSetTrustInput = typeof MailSetTrustInput.Type;
export type MailEmailMd = typeof MailEmailMd.Type;
export type MailWriteEmailMdInput = typeof MailWriteEmailMdInput.Type;
export type MailDryRunRuleInput = typeof MailDryRunRuleInput.Type;
export type MailDryRunRuleResult = typeof MailDryRunRuleResult.Type;
export type MailSeedVoiceResult = typeof MailSeedVoiceResult.Type;
export type MailDismissRecapInput = typeof MailDismissRecapInput.Type;
