import {
  CommandId,
  MAIL_SESSION_PROJECT_ID,
  type MailAccount,
  MailAccountId,
  type MailAccountConnection,
  type MailActor,
  type MailCategory,
  type MailDraft,
  MailDraftId,
  MailError,
  type MailRule,
  type MailSettings,
  type MailSettleReason,
  type MailStreamEvent,
  type MailThreadAction,
  type MailThreadDetail,
  type MailThreadId,
  type MailThreadRow,
  type MailTrustRecord,
  MessageId,
  type ModelSelection,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type {
  MailActInput,
  MailActionKind,
  MailActionPage,
  MailActResult,
  MailAddAccountInput,
  MailDryRunRuleResult,
  MailEmailMd,
  MailListActionsInput,
  MailListSettledInput,
  MailOpenSessionInput,
  MailOpenSessionResult,
  MailSaveDraftInput,
  MailSearchInput,
  MailSearchResult,
  MailSeedVoiceResult,
  MailSendDraftInput,
  MailSetTrustInput,
  MailThreadPage,
  MailTrustList,
  MailUpdateAccountInput,
  MailUpdateSettingsInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { classifyImapError, verifyLogin } from "./imapSession.ts";
import * as MailCredentials from "./MailCredentials.ts";
import * as MailEngine from "./MailEngine.ts";
import { matchesRule, prefilter, type PrefilterResult } from "./mailPrefilter.ts";
import {
  buildSessionPrompt,
  buildTriagePrompt,
  buildVoicePrompt,
  compileEmailMd,
  EMAIL_MD_TEMPLATE,
  relevantEmailMd,
  type TriageItem,
} from "./mailPrompts.ts";
import * as MailStore from "./MailStore.ts";
import * as MailSync from "./MailSync.ts";
import {
  cleanForDisplay,
  cleanForModel,
  domainOf,
  estimateTokens,
  firstLine,
  looksLikeInstructionsToAi,
} from "./mailText.ts";
import {
  canSkipModel,
  categoryKey,
  decide,
  emptyRecord,
  LOW_CONFIDENCE,
  recordApproval,
  recordRejection,
  senderKey,
  setLevel,
  type TrustRecord,
} from "./mailTrust.ts";
import { buildRaw, classifySmtpError, sendRaw } from "./smtpSend.ts";

type MailStreamEventType = MailStreamEvent;

const L1_BATCH = 12;
const L1_TEXT_CHARS = 1_200;
const BODY_WAIT_MS = 5 * 60_000;
const SESSION_MESSAGE_CHARS = 3_000;
const SEND_DEDUPE_MS = 10 * 60_000;
const MAX_DRAFT_EDITS = 5;

const MAIL_CATEGORIES = new Set<MailCategory>([
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
const SETTLE_REASONS = new Set<MailSettleReason>(["fyi", "receipt", "noise", "done"]);

interface Preset {
  readonly connection: Omit<MailAccountConnection, "username">;
}

const PRESETS: ReadonlyArray<{ readonly domains: ReadonlyArray<string>; readonly preset: Preset }> =
  [
    {
      domains: ["gmail.com", "googlemail.com"],
      preset: {
        connection: {
          imapHost: "imap.gmail.com",
          imapPort: 993,
          imapTls: true,
          smtpHost: "smtp.gmail.com",
          smtpPort: 465,
          smtpTls: true,
        },
      },
    },
    {
      domains: ["icloud.com", "me.com", "mac.com"],
      preset: {
        connection: {
          imapHost: "imap.mail.me.com",
          imapPort: 993,
          imapTls: true,
          smtpHost: "smtp.mail.me.com",
          smtpPort: 587,
          smtpTls: false,
        },
      },
    },
    {
      domains: ["yahoo.com", "ymail.com"],
      preset: {
        connection: {
          imapHost: "imap.mail.yahoo.com",
          imapPort: 993,
          imapTls: true,
          smtpHost: "smtp.mail.yahoo.com",
          smtpPort: 465,
          smtpTls: true,
        },
      },
    },
    {
      domains: ["fastmail.com", "fastmail.fm"],
      preset: {
        connection: {
          imapHost: "imap.fastmail.com",
          imapPort: 993,
          imapTls: true,
          smtpHost: "smtp.fastmail.com",
          smtpPort: 465,
          smtpTls: true,
        },
      },
    },
  ];

function presetFor(email: string): MailAccountConnection | null {
  const domain = domainOf(email);
  const match = PRESETS.find((entry) => entry.domains.includes(domain));
  return match ? { ...match.preset.connection, username: email } : null;
}

const isMailError = Schema.is(MailError);

// Our own JSON (records we wrote) parses or falls back; it never carries user-shaped cycles.
const toJson = (value: unknown): string => JSON.stringify(value);
const fromJson = <A>(raw: string | null, fallback: A): A => {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as A;
  } catch {
    return fallback;
  }
};

const isoMillis = (iso: string): number =>
  DateTime.make(iso).pipe(Option.match({ onNone: () => 0, onSome: DateTime.toEpochMillis }));

const storeError = () =>
  new MailError({ code: "unavailable", message: "The mail store could not be read or written." });
const notFound = (what: string) =>
  new MailError({ code: "not_found", message: `That ${what} no longer exists.` });
const invalid = (message: string) => new MailError({ code: "invalid", message });

export interface MailActorInfo {
  readonly actor: MailActor;
  readonly label?: string | undefined;
}

export class MailService extends Context.Service<
  MailService,
  {
    readonly subscribe: Stream.Stream<MailStreamEventType, MailError>;
    readonly getThread: (threadId: MailThreadId) => Effect.Effect<MailThreadDetail, MailError>;
    readonly listSettled: (input: MailListSettledInput) => Effect.Effect<MailThreadPage, MailError>;
    readonly listActive: (limit: number) => Effect.Effect<ReadonlyArray<MailThreadRow>, MailError>;
    readonly search: (input: MailSearchInput) => Effect.Effect<MailSearchResult, MailError>;
    readonly act: (
      input: MailActInput,
      actor: MailActorInfo,
    ) => Effect.Effect<MailActResult, MailError>;
    readonly undo: (actionId: number, actor: MailActorInfo) => Effect.Effect<void, MailError>;
    readonly listActions: (input: MailListActionsInput) => Effect.Effect<MailActionPage, MailError>;
    readonly saveDraft: (
      input: MailSaveDraftInput,
      actor: MailActorInfo,
    ) => Effect.Effect<MailDraft, MailError>;
    readonly discardDraft: (draftId: MailDraftId) => Effect.Effect<void, MailError>;
    readonly sendDraft: (input: MailSendDraftInput) => Effect.Effect<MailDraft, MailError>;
    readonly openSession: (
      input: MailOpenSessionInput,
    ) => Effect.Effect<MailOpenSessionResult, MailError>;
    readonly addAccount: (input: MailAddAccountInput) => Effect.Effect<MailAccount, MailError>;
    readonly updateAccount: (
      input: MailUpdateAccountInput,
    ) => Effect.Effect<MailAccount, MailError>;
    readonly removeAccount: (accountId: MailAccountId) => Effect.Effect<void, MailError>;
    readonly syncNow: (accountId: MailAccountId | undefined) => Effect.Effect<void, MailError>;
    readonly updateSettings: (
      input: MailUpdateSettingsInput,
    ) => Effect.Effect<MailSettings, MailError>;
    readonly listTrust: Effect.Effect<MailTrustList, MailError>;
    readonly setTrust: (input: MailSetTrustInput) => Effect.Effect<void, MailError>;
    readonly readEmailMd: Effect.Effect<MailEmailMd, MailError>;
    readonly writeEmailMd: (content: string) => Effect.Effect<MailEmailMd, MailError>;
    readonly dryRunRule: (rule: MailRule) => Effect.Effect<MailDryRunRuleResult, MailError>;
    readonly seedVoice: Effect.Effect<MailSeedVoiceResult, MailError>;
    readonly dismissRecap: (date: string) => Effect.Effect<void, MailError>;
    /** Triages until no pending thread can progress. The worker runs it after a debounce. */
    readonly drainTriage: Effect.Effect<void>;
  }
>()("t3/mail/MailService") {}

const make = Effect.gen(function* () {
  const store = yield* MailStore.MailStore;
  const engine = yield* MailEngine.MailEngine;
  const sync = yield* MailSync.MailSync;
  const credentials = yield* MailCredentials.MailCredentials;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const projects = yield* ProjectService.ProjectService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const stateLock = yield* Semaphore.make(1);

  const emailMdPath = path.join(store.workspaceDir, "EMAIL.md");
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const isoBefore = (now: DateTime.Utc, days: number) =>
    DateTime.formatIso(DateTime.subtract(now, { days }));
  const uuid = random.uuidV4().pipe(Effect.orDie);
  const sqlSafe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((error) => (isMailError(error) ? error : storeError())));

  const readEmailMdText = Effect.gen(function* () {
    const exists = yield* fs.exists(emailMdPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      yield* fs.makeDirectory(store.workspaceDir, { recursive: true }).pipe(Effect.ignore);
      yield* fs.writeFileString(emailMdPath, EMAIL_MD_TEMPLATE).pipe(Effect.ignore);
      return EMAIL_MD_TEMPLATE;
    }
    return yield* fs.readFileString(emailMdPath).pipe(Effect.orElseSucceed(() => ""));
  });
  let compiledCache: { readonly source: string; readonly compiled: string } | null = null;
  const compiledRules = readEmailMdText.pipe(
    Effect.map((source) => {
      if (compiledCache?.source !== source)
        compiledCache = { source, compiled: compileEmailMd(source) };
      return compiledCache.compiled;
    }),
  );

  const trustKeys = (thread: Pick<MailStore.ThreadRecord, "fromAddress" | "category">) => ({
    sender: senderKey(thread.fromAddress),
    category: thread.category && thread.category !== "person" ? categoryKey(thread.category) : null,
  });

  const loadTrust = Effect.fn("MailService.loadTrust")(function* (
    thread: Pick<MailStore.ThreadRecord, "fromAddress" | "category">,
  ) {
    const keys = trustKeys(thread);
    const records = yield* store.getTrust([keys.sender, ...(keys.category ? [keys.category] : [])]);
    return {
      keys,
      sender: records.get(keys.sender) ?? null,
      category: keys.category ? (records.get(keys.category) ?? null) : null,
    };
  });

  /** Applies an approval or rejection to both keys; returns the records as they were, for undo. */
  const updateTrust = Effect.fn("MailService.updateTrust")(function* (
    thread: MailStore.ThreadRecord,
    change:
      | { readonly type: "approve"; readonly reason: MailSettleReason }
      | { readonly type: "reject" },
  ) {
    const settings = yield* engine.settings;
    const now = yield* nowIso;
    const { keys, sender, category } = yield* loadTrust(thread);
    const before: Array<TrustRecord> = [];
    const apply = Effect.fnUntraced(function* (
      record: TrustRecord | null,
      key: string,
      kind: TrustRecord["kind"],
    ) {
      const current = record ?? emptyRecord(key, kind);
      before.push(current);
      const next =
        change.type === "approve"
          ? recordApproval(current, {
              threshold: settings.trustThreshold,
              reason: change.reason,
              bulk: thread.bulk,
            })
          : recordRejection(current);
      yield* store.putTrust(next, now);
    });
    yield* apply(sender, keys.sender, "sender");
    if (keys.category) yield* apply(category, keys.category, "category");
    return before;
  });

  const statePatchOf = (thread: MailStore.ThreadRecord): MailStore.ThreadStatePatch => ({
    state: thread.state,
    stateAt: thread.stateAt,
    pinnedAt: thread.pinnedAt,
    workingReason: thread.workingReason,
    settledReason: thread.settledReason,
    settledBy: thread.settledBy,
    snoozedUntil: thread.snoozedUntil,
    snoozeOnReply: thread.snoozeOnReply,
    suggestionReason: thread.suggestionReason,
    suggestionConfidence: thread.suggestionConfidence,
    nudge: thread.nudge,
    unread: thread.unread,
  });

  const settledPatch = (
    now: string,
    reason: MailSettleReason,
    by: MailActor,
  ): MailStore.ThreadStatePatch => ({
    state: "settled",
    stateAt: now,
    settledReason: reason,
    settledBy: by,
    workingReason: null,
    snoozedUntil: null,
    snoozeOnReply: false,
    suggestionReason: null,
    suggestionConfidence: null,
    nudge: null,
  });

  const activePatch = (now: string): MailStore.ThreadStatePatch => ({
    state: "active",
    stateAt: now,
    settledReason: null,
    settledBy: null,
    workingReason: null,
    snoozedUntil: null,
    snoozeOnReply: false,
  });

  const mirror = Effect.fn("MailService.mirror")(function* (
    thread: MailStore.ThreadRecord,
    kind: "archive" | "unarchive",
  ) {
    const settings = yield* engine.settings;
    if (!settings.serverMirroring) return;
    yield* sync.enqueue(thread.accountId, { kind, threadId: thread.id });
  });

  const actOne = Effect.fn("MailService.actOne")(function* (
    thread: MailStore.ThreadRecord,
    action: MailThreadAction,
    actor: MailActorInfo,
    now: string,
  ) {
    const before = statePatchOf(thread);
    let patch: MailStore.ThreadStatePatch | null = null;
    let trustBefore: ReadonlyArray<TrustRecord> = [];
    let kind: MailActionKind = "settle";
    let reason: string | null = null;
    let undoable = true;
    switch (action.type) {
      case "settle":
      case "approve": {
        const settleReason =
          action.type === "approve"
            ? (thread.suggestionReason ?? "fyi")
            : (action.reason ?? thread.suggestionReason ?? "done");
        patch = settledPatch(now, settleReason, actor.actor);
        // "Settle these" is the user agreeing with the AI's read; it counts toward graduation.
        if (actor.actor === "user") {
          trustBefore = yield* updateTrust(thread, { type: "approve", reason: settleReason });
        }
        kind = action.type === "approve" ? "approve" : "settle";
        reason = settleReason;
        yield* mirror(thread, "archive");
        break;
      }
      case "keep":
      case "unsettle": {
        const wasAi =
          thread.state === "settled" && (thread.settledBy === "ai" || thread.settledBy === "rule");
        if (action.type === "keep" || wasAi) {
          trustBefore = yield* updateTrust(thread, { type: "reject" });
        }
        patch = {
          ...(thread.state === "active" ? {} : activePatch(now)),
          suggestionReason: null,
          suggestionConfidence: null,
        };
        kind = action.type === "keep" ? "reject" : "unsettle";
        if (thread.state === "settled") yield* mirror(thread, "unarchive");
        break;
      }
      case "pin":
        patch = { pinnedAt: now };
        kind = "pin";
        break;
      case "unpin":
        patch = { pinnedAt: null };
        kind = "unpin";
        break;
      case "snooze":
        if (action.until === null && !action.onReply)
          return yield* invalid("Pick a time or snooze until a reply.");
        patch = {
          state: "snoozed",
          stateAt: now,
          snoozedUntil: action.until,
          snoozeOnReply: action.onReply,
          workingReason: null,
          settledReason: null,
          settledBy: null,
          suggestionReason: null,
          suggestionConfidence: null,
        };
        kind = "snooze";
        reason = action.until;
        break;
      case "unsnooze":
        patch = activePatch(now);
        kind = "unsnooze";
        break;
      case "never_show": {
        const now2 = now;
        const { keys, sender } = yield* loadTrust(thread);
        const current = sender ?? emptyRecord(keys.sender, "sender");
        trustBefore = [current];
        yield* store.putTrust({ ...setLevel(current, "never"), reason: "noise" }, now2);
        patch = settledPatch(now, "noise", actor.actor);
        kind = "never_show";
        reason = "noise";
        yield* mirror(thread, "archive");
        break;
      }
      case "mark_read":
        patch = { unread: false };
        kind = "settle";
        undoable = false;
        yield* sync.enqueue(thread.accountId, { kind: "seen", threadId: thread.id, seen: true });
        yield* store.patchThread(thread.id, patch);
        return null;
      case "wait_for_reply":
        patch = {
          state: "working",
          stateAt: now,
          workingReason: "waiting",
          settledReason: null,
          settledBy: null,
          suggestionReason: null,
          suggestionConfidence: null,
        };
        kind = "unsettle";
        reason = "waiting";
        break;
    }
    yield* store.patchThread(thread.id, patch);
    return yield* store.insertAction({
      at: now,
      actor: actor.actor,
      actorLabel: actor.label ?? null,
      kind,
      threadId: thread.id,
      reason,
      undo: undoable ? { threadPatch: before, trust: trustBefore } : null,
    });
  });

  const act: MailService["Service"]["act"] = (input, actor) =>
    stateLock
      .withPermits(1)(
        Effect.gen(function* () {
          const now = yield* nowIso;
          const threads = yield* store.getThreads(input.threadIds);
          if (threads.length === 0) return yield* notFound("email");
          const actionIds: Array<number> = [];
          for (const thread of threads) {
            const id = yield* actOne(thread, input.action, actor, now);
            if (id !== null) actionIds.push(id);
          }
          yield* engine.publishThreads(threads.map((thread) => thread.id));
          yield* engine.publishStatus;
          return { actionIds };
        }),
      )
      .pipe(sqlSafe, Effect.withSpan("MailService.act"));

  const undo: MailService["Service"]["undo"] = (actionId, actor) =>
    stateLock
      .withPermits(1)(
        Effect.gen(function* () {
          const action = yield* store.getAction(actionId);
          if (action === null) return yield* notFound("action");
          if (action.undo === null || action.undoneAt !== null) {
            return yield* invalid("That action cannot be undone.");
          }
          const now = yield* nowIso;
          const thread = action.threadId === null ? null : yield* store.getThread(action.threadId);
          for (const record of action.undo.trust ?? []) yield* store.putTrust(record, now);
          if (thread !== null && action.undo.threadPatch) {
            yield* store.patchThread(thread.id, action.undo.threadPatch);
            const wasSettle =
              action.kind === "settle" || action.kind === "approve" || action.kind === "never_show";
            if (wasSettle) yield* mirror(thread, "unarchive");
            if (
              action.kind === "unsettle" &&
              thread.state === "active" &&
              action.undo.threadPatch.state === "settled"
            ) {
              yield* mirror(thread, "archive");
            }
            // Undoing an AI settle is a correction: the sender and category go back to suggest mode.
            if (wasSettle && (action.actor === "ai" || action.actor === "rule")) {
              const restored = yield* store.getThread(thread.id);
              if (restored !== null) yield* updateTrust(restored, { type: "reject" });
            }
          }
          yield* store.markActionUndone(actionId, now);
          void actor;
          if (thread !== null) yield* engine.publishThreads([thread.id]);
          yield* engine.publishStatus;
        }),
      )
      .pipe(sqlSafe, Effect.withSpan("MailService.undo"));

  const listActions: MailService["Service"]["listActions"] = Effect.fn("MailService.listActions")(
    function* (input) {
      const page = yield* store.listActions({
        beforeId: input.beforeId,
        actor: input.actor,
        threadId: undefined,
        limit: input.limit ?? 50,
      });
      const threads = yield* store.getThreads([
        ...new Set(page.actions.flatMap((action) => (action.threadId ? [action.threadId] : []))),
      ]);
      const byId = new Map(threads.map((thread) => [thread.id as string, thread]));
      return {
        actions: page.actions.map((action) =>
          MailStore.actionEntry(
            action,
            action.threadId ? (byId.get(action.threadId) ?? null) : null,
          ),
        ),
        hasMore: page.hasMore,
      };
    },
    sqlSafe,
  );

  const getThread: MailService["Service"]["getThread"] = Effect.fn("MailService.getThread")(
    function* (threadId) {
      const thread = yield* store.getThread(threadId);
      if (thread === null) return yield* notFound("email");
      const messages = yield* store.threadMessages(threadId);
      const drafts = yield* store.draftsForThread(threadId);
      const related = thread.fromAddress
        ? yield* store.relatedThreads(thread.fromAddress, threadId, 5)
        : [];
      const actions = yield* store.listActions({
        beforeId: undefined,
        actor: undefined,
        threadId,
        limit: 20,
      });
      const open = drafts.some((draft) => draft.status === "draft" || draft.status === "failed");
      return {
        thread: MailStore.threadRow(thread, open),
        messages: messages.map((message) => MailStore.messageView(message, cleanForDisplay)),
        drafts: drafts.filter((draft) => draft.status !== "sent").map(MailStore.draftView),
        related: related.map((entry) => ({
          id: entry.id,
          subject: entry.subject,
          lastMessageAt: entry.lastMessageAt,
          state: entry.state,
        })),
        actions: actions.actions.map((action) => MailStore.actionEntry(action, thread)),
        verdict: thread.verdict,
      } satisfies MailThreadDetail;
    },
    sqlSafe,
  );

  const listSettled: MailService["Service"]["listSettled"] = Effect.fn("MailService.listSettled")(
    function* (input) {
      const page = yield* store.settledPage({
        before: input.before,
        reason: input.reason,
        byAi: input.byAi,
        limit: input.limit ?? 50,
      });
      return {
        threads: yield* engine.rows(page.threads.map((thread) => thread.id)),
        hasMore: page.hasMore,
      };
    },
    Effect.map((page) => ({
      ...page,
      threads: [...page.threads].sort((a, b) =>
        a.stateAt === b.stateAt ? b.id.localeCompare(a.id) : b.stateAt.localeCompare(a.stateAt),
      ),
    })),
    sqlSafe,
  );

  const listActive: MailService["Service"]["listActive"] = (limit) =>
    store.threadsByState("active").pipe(
      Effect.flatMap((threads) =>
        engine.rows(
          [...threads]
            .sort((a, b) => a.stateAt.localeCompare(b.stateAt))
            .slice(0, limit)
            .map((thread) => thread.id),
        ),
      ),
      sqlSafe,
    );

  const search: MailService["Service"]["search"] = Effect.fn("MailService.search")(function* (
    input,
  ) {
    const limit = input.limit ?? 50;
    const query = input.query.trim();
    const phrase = query.replace(/^"(.*)"$/, "$1");
    // Trigram search needs three characters; shorter queries scan.
    const match = phrase.length >= 3 ? `"${phrase.replace(/"/g, '""')}"` : null;
    const local = yield* store.search(match, `%${phrase.replace(/[%_]/g, "")}%`, limit);
    let serverMatches = 0;
    const ids = [...local];
    if (input.server) {
      const accounts = yield* store.listAccounts;
      for (const account of accounts.filter((entry) => entry.provider === "gmail")) {
        const found = yield* sync.searchGmail(account.id, query);
        serverMatches += found.length;
        for (const id of found) if (!ids.includes(id)) ids.push(id);
      }
    }
    const rows = yield* engine.rows(ids.slice(0, limit));
    const order = new Map(ids.map((id, index) => [id as string, index]));
    return {
      threads: [...rows].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
      serverMatches,
    };
  }, sqlSafe);

  const applyDecision = Effect.fn("MailService.applyDecision")(function* (
    thread: MailStore.ThreadRecord,
    input: {
      readonly verdict: MailStore.ThreadVerdict;
      readonly prefiltered: PrefilterResult;
      readonly line: string;
      readonly suggestedAction: string | null;
      readonly category: MailCategory;
      readonly urgent: boolean;
      readonly injection: boolean;
    },
  ) {
    const now = yield* nowIso;
    const guardrail = input.prefiltered.guardrail ?? (input.urgent ? "urgent" : null);
    yield* store.setTriage(thread.id, {
      line: input.line,
      suggestedAction: input.suggestedAction,
      category: input.category,
      guardrail,
      bulk: input.prefiltered.bulk,
      verdict: input.verdict,
      triageState: "done",
      triagedCount: thread.incomingCount,
      injection: input.injection,
    });
    const current = yield* store.getThread(thread.id);
    // The user may have moved it while L1 ran; their choice wins.
    if (current === null || current.state !== "active" || current.pinnedAt !== null) return;
    const trust = yield* loadTrust({ fromAddress: current.fromAddress, category: input.category });
    const reason = SETTLE_REASONS.has(input.verdict.reason as MailSettleReason)
      ? (input.verdict.reason as MailSettleReason)
      : null;
    const decision = decide({
      verdict: { decision: input.verdict.decision, reason, confidence: input.verdict.confidence },
      guardrail,
      sender: trust.sender,
      category: trust.category,
      rule: input.prefiltered.rule,
    });
    if (decision.type === "auto_settle") {
      const by: MailActor =
        decision.via === "rule" || decision.via === "never_show" ? "rule" : "ai";
      yield* store.patchThread(current.id, settledPatch(now, decision.reason, by));
      yield* store.insertAction({
        at: now,
        actor: by,
        actorLabel: null,
        kind: "settle",
        threadId: current.id,
        reason: decision.reason,
        undo: { threadPatch: statePatchOf(current), trust: [] },
      });
      yield* mirror(current, "archive");
    } else if (decision.type === "suggest") {
      yield* store.patchThread(current.id, {
        suggestionReason: decision.reason,
        suggestionConfidence: decision.confidence,
      });
    } else {
      yield* store.patchThread(current.id, { suggestionReason: null, suggestionConfidence: null });
    }
  });

  interface Prepared {
    readonly thread: MailStore.ThreadRecord;
    readonly text: string;
    readonly prefiltered: PrefilterResult;
    readonly repliedTo: boolean;
    readonly item: TriageItem;
  }

  const prepare = Effect.fn("MailService.prepare")(function* (
    thread: MailStore.ThreadRecord,
    settings: MailSettings,
    now: number,
  ) {
    const messages = yield* store.threadMessages(thread.id);
    const incoming = messages.filter((message) => !message.outgoing);
    const latest = incoming.at(-1) ?? messages.at(-1);
    if (latest === undefined) return null;
    if (latest.bodyState === "pending" && now - isoMillis(latest.date) < BODY_WAIT_MS)
      return "wait" as const;
    const account = yield* store.getAccount(thread.accountId);
    const me = account?.email.toLowerCase() ?? "";
    const text = cleanForModel(latest.body ?? "", L1_TEXT_CHARS);
    const replied = yield* store.repliedToAddresses(thread.accountId, [latest.from.address]);
    const toMe = latest.to.some((entry) => entry.address === me);
    const prefiltered = prefilter(
      {
        fromAddress: latest.from.address,
        fromName: latest.from.name,
        subject: latest.subject,
        text,
        listUnsubscribe: latest.listUnsubscribe,
        listId: latest.listId,
        precedence: latest.precedence,
        autoSubmitted: latest.autoSubmitted,
        hasCalendarInvite: latest.calendar,
        repliedTo: replied.size > 0,
        ccCount: latest.cc.length,
        ccOnly: !toMe && latest.cc.some((entry) => entry.address === me),
      },
      settings.rules,
    );
    const earlier =
      messages.length > 1
        ? `${messages.length - 1} earlier messages; last from ${messages.at(-2)!.outgoing ? "the user" : messages.at(-2)!.from.name || messages.at(-2)!.from.address}: ${firstLine(messages.at(-2)!.body ?? "", 100)}`
        : null;
    const flags = [
      prefiltered.bulk ? "bulk or list mail" : null,
      replied.size > 0 ? "the user has written to this sender before" : null,
      !toMe && latest.cc.length >= 2
        ? `the user is one of ${latest.to.length + latest.cc.length} recipients`
        : null,
      latest.attachments.length > 0 ? `${latest.attachments.length} attachment(s)` : null,
    ].filter((flag): flag is string => flag !== null);
    return {
      thread,
      text,
      prefiltered,
      repliedTo: replied.size > 0,
      item: {
        id: "",
        from: latest.from.name
          ? `${latest.from.name} <${latest.from.address}>`
          : latest.from.address,
        subject: latest.subject,
        text: text || "(no text)",
        earlier,
        flags,
      },
    } satisfies Prepared;
  });

  const recordUsage = (kind: string, model: string, chars: number, emails: number) =>
    nowIso.pipe(
      Effect.flatMap((at) =>
        store.insertUsage({ at, kind, model, tokens: estimateTokens(chars), emails }),
      ),
    );

  const runModel = Effect.fn("MailService.runModel")(function* (
    batch: ReadonlyArray<Prepared>,
    selection: ModelSelection,
    kind: "l1" | "l1_escalated",
  ) {
    const items = batch.map((entry, index) => ({ ...entry.item, id: `e${index + 1}` }));
    const prompt = buildTriagePrompt({ rules: yield* compiledRules, items });
    const result = yield* textGeneration
      .generateMailTriage({ cwd: store.workspaceDir, prompt, modelSelection: selection })
      .pipe(Effect.timeout("3 minutes"));
    const outputChars = toJson(result).length;
    yield* recordUsage(kind, selection.model, prompt.length + outputChars, batch.length);
    const byId = new Map(result.verdicts.map((verdict) => [verdict.id, verdict]));
    return batch.map((entry, index) => ({ entry, verdict: byId.get(`e${index + 1}`) ?? null }));
  });

  const triageRound = Effect.gen(function* () {
    const ids = yield* store.pendingTriage(L1_BATCH * 4);
    if (ids.length === 0) return false;
    const settings = yield* engine.settings;
    const usage = yield* engine.usage;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const threads = yield* store.getThreads(ids);
    const forModel: Array<Prepared> = [];
    let progressed = false;
    for (const thread of threads) {
      const prepared = yield* prepare(thread, settings, now);
      if (prepared === "wait") continue;
      progressed = true;
      if (prepared === null) {
        yield* store.setTriage(thread.id, { triageState: "done" });
        continue;
      }
      const trust = yield* loadTrust({
        fromAddress: thread.fromAddress,
        category: prepared.prefiltered.category,
      });
      const line = firstLine(prepared.text) || thread.subject;
      const injection = looksLikeInstructionsToAi(prepared.text);
      const skip =
        prepared.prefiltered.rule !== null ||
        canSkipModel({
          sender: trust.sender,
          guardrail: prepared.prefiltered.guardrail,
          bulk: prepared.prefiltered.bulk,
        }) ||
        prepared.prefiltered.verdict !== null;
      if (skip) {
        const fromMemory = trust.sender?.trust === "auto" || trust.sender?.trust === "never";
        const ruleVerdict = prepared.prefiltered.verdict;
        yield* applyDecision(thread, {
          verdict: {
            decision: prepared.prefiltered.rule?.action === "keep" ? "keep" : "settle",
            reason:
              ruleVerdict?.reason ??
              trust.sender?.reason ??
              prepared.prefiltered.rule?.reason ??
              "fyi",
            confidence: ruleVerdict?.confidence ?? 0.9,
            source: fromMemory ? "memory" : "rule",
          },
          prefiltered: prepared.prefiltered,
          line,
          suggestedAction: null,
          category: prepared.prefiltered.category,
          urgent: false,
          injection,
        });
        continue;
      }
      if (usage.capped || settings.defaultModelSelection === null) {
        // At the cap, or before a model is picked, only rules and settle-memory run.
        yield* store.setTriage(thread.id, {
          line,
          category: prepared.prefiltered.category,
          guardrail: prepared.prefiltered.guardrail,
          bulk: prepared.prefiltered.bulk,
          triageState: usage.capped ? "capped" : "waiting_model",
          injection,
        });
        continue;
      }
      forModel.push(prepared);
    }
    const selection = settings.defaultModelSelection;
    if (selection !== null) {
      for (let start = 0; start < forModel.length; start += L1_BATCH) {
        const batch = forModel.slice(start, start + L1_BATCH);
        const results = yield* runModel(batch, selection, "l1").pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Mail L1 batch failed; threads wait for the next try.").pipe(
              Effect.annotateLogs({ count: batch.length, cause: String(cause).slice(0, 200) }),
              Effect.andThen(
                Effect.forEach(batch, (entry) =>
                  store.setTriage(entry.thread.id, { triageState: "waiting_model" }),
                ),
              ),
              Effect.as([] as ReadonlyArray<{ entry: Prepared; verdict: null }>),
            ),
          ),
        );
        const escalate = settings.escalationModelSelection;
        const needsEscalation = results.filter(
          (result) =>
            escalate !== null &&
            result.verdict !== null &&
            (result.verdict.confidence < LOW_CONFIDENCE || result.entry.repliedTo),
        );
        const escalated =
          escalate !== null && needsEscalation.length > 0
            ? yield* runModel(
                needsEscalation.map((result) => result.entry),
                escalate,
                "l1_escalated",
              ).pipe(Effect.orElseSucceed(() => []))
            : [];
        const escalatedBy = new Map(
          escalated.map((result) => [result.entry.thread.id as string, result.verdict]),
        );
        for (const result of results) {
          const better = escalatedBy.get(result.entry.thread.id);
          const verdict = better ?? result.verdict;
          const prepared = result.entry;
          if (verdict === null) {
            yield* store.setTriage(prepared.thread.id, { triageState: "waiting_model" });
            continue;
          }
          const modelCategory = MAIL_CATEGORIES.has(verdict.category as MailCategory)
            ? (verdict.category as MailCategory)
            : "other";
          const category =
            prepared.prefiltered.category === "person" ||
            prepared.prefiltered.category === "notification"
              ? modelCategory
              : prepared.prefiltered.category;
          yield* applyDecision(prepared.thread, {
            verdict: {
              decision: verdict.decision,
              reason: verdict.reason,
              confidence: Math.max(0, Math.min(1, verdict.confidence)),
              source: better ? "escalated" : "model",
            },
            prefiltered: prepared.prefiltered,
            line:
              verdict.summary.trim().slice(0, 140) ||
              firstLine(prepared.text) ||
              prepared.thread.subject,
            suggestedAction: verdict.action.trim().slice(0, 40) || null,
            category,
            urgent: verdict.urgent,
            injection: verdict.injection || looksLikeInstructionsToAi(prepared.text),
          });
        }
      }
    }
    yield* engine.publishThreads(threads.map((thread) => thread.id));
    yield* engine.publishStatus;
    return progressed;
  }).pipe(Effect.withSpan("MailService.triageRound"));

  const drainTriage = Effect.gen(function* () {
    let more = true;
    while (more) {
      more = yield* stateLock
        .withPermits(1)(triageRound)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Mail triage round failed.").pipe(
              Effect.annotateLogs({ cause: String(cause).slice(0, 300) }),
              Effect.as(false),
            ),
          ),
        );
    }
  });

  const triageWorker = Effect.gen(function* () {
    while (true) {
      yield* Queue.take(engine.triageSignal);
      // Let a sync burst land before batching it.
      yield* Effect.sleep("2 seconds");
      yield* drainTriage;
    }
  });

  const tick = stateLock
    .withPermits(1)(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const iso = DateTime.formatIso(now);
        const settings = yield* engine.settings;
        const changed: Array<MailThreadId> = [];
        for (const thread of yield* store.dueSnoozes(iso)) {
          yield* store.patchThread(thread.id, activePatch(iso));
          yield* store.insertAction({
            at: iso,
            actor: "mail",
            actorLabel: null,
            kind: "returned",
            threadId: thread.id,
            reason: "snooze",
            undo: null,
          });
          changed.push(thread.id);
        }
        const waitingCutoff = isoBefore(now, settings.nudgeWaitingDays);
        for (const thread of yield* store.repliedWaiting(waitingCutoff)) {
          // Follow-up nudge: the user wrote last and nobody answered.
          yield* store.patchThread(thread.id, {
            ...activePatch(iso),
            nudge: `waiting:${settings.nudgeWaitingDays}`,
          });
          changed.push(thread.id);
        }
        const replyCutoff = isoBefore(now, settings.nudgeReplyDays);
        for (const thread of yield* store.threadsByState("active")) {
          if (
            thread.nudge === null &&
            thread.category === "person" &&
            thread.lastIncomingAt !== null &&
            thread.lastIncomingAt === thread.lastMessageAt &&
            thread.lastIncomingAt <= replyCutoff
          ) {
            yield* store.patchThread(thread.id, { nudge: `unanswered:${settings.nudgeReplyDays}` });
            changed.push(thread.id);
          }
        }
        for (const thread of yield* store.threadsByState("working")) {
          if (thread.workingReason !== "drafting" || thread.chatThreadId === null) continue;
          const shell = yield* threadManagement
            .getThreadShell(ThreadId.make(thread.chatThreadId))
            .pipe(Effect.orElseSucceed(() => null));
          const running =
            shell !== null &&
            (shell as { readonly latestRun?: { readonly status?: string } | null }).latestRun
              ?.status === "running";
          if (!running) {
            yield* store.patchThread(thread.id, { ...activePatch(iso), stateAt: thread.stateAt });
            changed.push(thread.id);
          }
        }
        if (changed.length > 0) yield* engine.publishThreads(changed);
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Mail tick failed.").pipe(
          Effect.annotateLogs({ cause: String(cause).slice(0, 300) }),
        ),
      ),
    );

  const saveDraft: MailService["Service"]["saveDraft"] = Effect.fn("MailService.saveDraft")(
    function* (input, actor) {
      const thread = yield* store.getThread(input.threadId);
      if (thread === null) return yield* notFound("email");
      const now = yield* nowIso;
      const existing = input.draftId ? yield* store.getDraft(input.draftId) : null;
      if (input.draftId && existing === null) return yield* notFound("draft");
      if (existing !== null && (existing.status === "sending" || existing.status === "sent")) {
        return yield* invalid("That draft was already sent.");
      }
      const id = existing?.id ?? MailDraftId.make(`draft-${yield* uuid}`);
      const draft: MailStore.DraftRecord = {
        id,
        threadId: thread.id,
        accountId: thread.accountId,
        to: input.to,
        cc: input.cc,
        subject: input.subject,
        body: input.body,
        origin: existing?.origin ?? actor.actor,
        status: "draft",
        error: null,
        updatedAt: now,
        sentAt: null,
        // What an agent wrote first, so the user's edits can teach later drafts.
        originalBody: existing?.originalBody ?? (actor.actor === "user" ? null : input.body),
        messageId: null,
      };
      yield* store.putDraft(draft);
      if (existing === null) {
        yield* store.insertAction({
          at: now,
          actor: actor.actor,
          actorLabel: actor.label ?? null,
          kind: "draft",
          threadId: thread.id,
          reason: null,
          undo: null,
        });
      }
      // A draft from an agent means the thread needs the user again.
      if (
        actor.actor !== "user" &&
        thread.state === "working" &&
        thread.workingReason === "drafting"
      ) {
        yield* store.patchThread(thread.id, { ...activePatch(now), stateAt: thread.stateAt });
      }
      yield* engine.publishThreads([thread.id]);
      return MailStore.draftView(draft);
    },
    sqlSafe,
  );

  const discardDraft: MailService["Service"]["discardDraft"] = Effect.fn(
    "MailService.discardDraft",
  )(function* (draftId) {
    const draft = yield* store.getDraft(draftId);
    if (draft === null) return;
    yield* store.deleteDraft(draftId);
    yield* engine.publishThreads([draft.threadId]);
  }, sqlSafe);

  const rememberEdit = Effect.fn("MailService.rememberEdit")(function* (
    original: string,
    final: string,
  ) {
    if (original.trim() === final.trim()) return;
    const raw = yield* store.getKv("draft-edits");
    const edits = fromJson<Array<{ before: string; after: string }>>(raw, []);
    edits.push({ before: original.slice(0, 600), after: final.slice(0, 600) });
    yield* store.setKv("draft-edits", toJson(edits.slice(-MAX_DRAFT_EDITS)));
  });

  const sendDraft: MailService["Service"]["sendDraft"] = Effect.fn("MailService.sendDraft")(
    function* (input) {
      const draft = yield* store.getDraft(input.draftId);
      if (draft === null) return yield* notFound("draft");
      if (draft.status === "sent") return MailStore.draftView(draft);
      if (draft.to.length + draft.cc.length === 0)
        return yield* invalid("Add at least one recipient.");
      const now = yield* nowIso;
      const recent = (yield* store.draftsForThread(draft.threadId)).find(
        (other) =>
          other.id !== draft.id &&
          other.status === "sent" &&
          other.body.trim() === input.body.trim() &&
          other.sentAt !== null &&
          isoMillis(now) - isoMillis(other.sentAt) < SEND_DEDUPE_MS,
      );
      if (recent) return yield* invalid("The same reply was sent a moment ago.");
      // One claim per approved body: a double tap or a retry cannot send twice.
      if (!(yield* store.claimDraftForSend(draft.id, input.body, now))) {
        const latest = yield* store.getDraft(draft.id);
        if (latest?.status === "sent" || latest?.status === "sending")
          return MailStore.draftView(latest);
        return yield* invalid(
          "The draft changed after you reviewed it. Review it again before sending.",
        );
      }
      const account = yield* store.getAccount(draft.accountId);
      if (account === null) return yield* notFound("account");
      const password = yield* credentials
        .get(account.id, account.credentialStore)
        .pipe(Effect.orElseSucceed(() => null));
      const fail = (message: string, code: "send_failed" | "auth_failed" = "send_failed") =>
        store
          .putDraft({ ...draft, status: "failed", error: message, updatedAt: now })
          .pipe(
            Effect.andThen(engine.publishThreads([draft.threadId])),
            Effect.andThen(Effect.fail(new MailError({ code, message }))),
          );
      if (password === null)
        return yield* fail("Re-enter the app password for this account.", "auth_failed");
      const messages = yield* store.threadMessages(draft.threadId);
      const last = messages.at(-1);
      const messageId = `<${yield* uuid}@${domainOf(account.email) || "t3.mail"}>`;
      const outgoing = {
        from: { name: account.displayName, address: account.email },
        to: draft.to,
        cc: draft.cc,
        subject: draft.subject,
        text: input.body,
        messageId,
        inReplyTo: last?.messageId ?? null,
        references: [
          ...(last?.references ?? []),
          ...(last?.messageId ? [last.messageId] : []),
        ].slice(-20),
      };
      const sent = yield* Effect.tryPromise({
        try: async () => {
          const raw = await buildRaw(outgoing);
          await sendRaw(
            {
              host: account.smtpHost,
              port: account.smtpPort,
              secure: account.smtpTls,
              user: account.username,
              password,
            },
            outgoing,
            raw,
          );
          return raw;
        },
        catch: (error) => classifySmtpError(error),
      }).pipe(Effect.exit);
      if (sent._tag === "Failure") {
        const failure = sent.cause.reasons.find((reason) => reason._tag === "Fail");
        const info =
          failure && failure._tag === "Fail"
            ? failure.error
            : { auth: false, detail: "Sending failed." };
        return yield* fail(info.detail, info.auth ? "auth_failed" : "send_failed");
      }
      const sentAt = yield* nowIso;
      const final: MailStore.DraftRecord = {
        ...draft,
        body: input.body,
        status: "sent",
        error: null,
        messageId,
        sentAt,
        updatedAt: sentAt,
      };
      yield* store.putDraft(final);
      const local = yield* store.upsertMessage({
        accountId: account.id,
        mailbox: "__local",
        uid: -Math.floor(isoMillis(sentAt) / 1000),
        messageId,
        threadId: draft.threadId,
        labels: null,
        inInbox: false,
        from: { name: account.displayName, address: account.email },
        to: draft.to.map((address) => ({ name: "", address })),
        cc: draft.cc.map((address) => ({ name: "", address })),
        subject: draft.subject,
        date: sentAt,
        inReplyTo: outgoing.inReplyTo,
        references: outgoing.references,
        seen: true,
        outgoing: true,
        size: input.body.length,
        attachments: [],
        listUnsubscribe: false,
        listId: null,
        precedence: null,
        autoSubmitted: null,
        calendar: false,
        textPart: null,
      });
      yield* store.setMessageBody(local.id, input.body);
      yield* store.refreshThreadAggregate(draft.threadId);
      const thread = yield* store.getThread(draft.threadId);
      if (thread !== null && thread.state !== "settled") {
        yield* store.patchThread(thread.id, settledPatch(sentAt, "replied", "user"));
      }
      yield* engine.afterBodies([draft.threadId]);
      yield* store.insertAction({
        at: sentAt,
        actor: "user",
        actorLabel: null,
        kind: "send",
        threadId: draft.threadId,
        reason: null,
        undo: null,
      });
      if (account.provider !== "gmail" && sent.value) {
        yield* sync.enqueue(account.id, {
          kind: "append_sent",
          raw: sent.value.toString("base64"),
        });
      }
      if (draft.originalBody !== null) yield* rememberEdit(draft.originalBody, input.body);
      yield* engine.publishThreads([draft.threadId]);
      return MailStore.draftView(final);
    },
    sqlSafe,
  );

  const ensureSessionProject = Effect.gen(function* () {
    const existing = yield* projects
      .getById(MAIL_SESSION_PROJECT_ID)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(existing)) return existing.value.id as ProjectId;
    yield* readEmailMdText;
    const created = yield* projects.bootstrap({
      commandId: CommandId.make(`mail:project:${yield* uuid}`),
      projectId: MAIL_SESSION_PROJECT_ID,
      title: "Mail",
      workspaceRoot: store.workspaceDir,
      createWorkspaceRootIfMissing: true,
    });
    return created.project.id as ProjectId;
  });

  const openSession: MailService["Service"]["openSession"] = Effect.fn("MailService.openSession")(
    function* (input) {
      const thread = yield* store.getThread(input.threadId);
      if (thread === null) return yield* notFound("email");
      const settings = yield* engine.settings;
      const projectId = yield* ensureSessionProject.pipe(
        Effect.mapError(
          () =>
            new MailError({ code: "unavailable", message: "Could not create the Mail project." }),
        ),
      );
      const now = yield* nowIso;
      const existingId = thread.chatThreadId === null ? null : ThreadId.make(thread.chatThreadId);
      const existingShell =
        existingId === null
          ? null
          : yield* threadManagement
              .getThreadShell(existingId)
              .pipe(Effect.orElseSucceed(() => null));
      if (existingId !== null && existingShell !== null) {
        if (input.prompt) {
          yield* threadManagement
            .sendToThread({
              projectId,
              commandId: CommandId.make(`mail:send:${yield* uuid}`),
              threadId: existingId,
              messageId: MessageId.make(yield* uuid),
              text: input.prompt,
              attachments: [],
              ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
              mode: "auto",
              createdBy: "user",
              creationSource: "server",
            })
            .pipe(
              Effect.mapError(
                () =>
                  new MailError({ code: "unavailable", message: "Could not reach the mail chat." }),
              ),
            );
          yield* store.patchThread(thread.id, {
            state: "working",
            stateAt: now,
            workingReason: "drafting",
          });
          yield* engine.publishThreads([thread.id]);
        }
        return { projectId, threadId: existingId, created: false };
      }
      const modelSelection =
        input.modelSelection ??
        settings.defaultModelSelection ??
        (yield* serverSettings.getSettings.pipe(
          Effect.map((server) => server.defaultModelSelection ?? null),
          Effect.orElseSucceed(() => null),
        ));
      if (modelSelection === null) {
        return yield* invalid("Pick a mail model in Settings → Mail first.");
      }
      const messages = (yield* store.threadMessages(thread.id)).slice(-8);
      const transcript = messages
        .map(
          (message) =>
            `From: ${message.outgoing ? "the user" : `${message.from.name} <${message.from.address}>`}\nDate: ${message.date}\nSubject: ${message.subject}\n\n${cleanForModel(message.body ?? "(body not downloaded)", SESSION_MESSAGE_CHARS)}`,
        )
        .join("\n\n---\n\n");
      const related = (yield* store.relatedThreads(thread.fromAddress, thread.id, 5))
        .map((entry) => `- ${entry.lastMessageAt.slice(0, 10)} ${entry.subject} (${entry.state})`)
        .join("\n");
      const emailMd = relevantEmailMd(yield* readEmailMdText, [
        thread.fromName,
        thread.fromAddress,
        domainOf(thread.fromAddress),
      ]);
      const editsRaw = yield* store.getKv("draft-edits");
      const edits = fromJson<Array<{ before: string; after: string }>>(editsRaw, []).slice(-3);
      const request =
        input.prompt ??
        "Read this email thread. Tell me in two lines what it needs from me, then draft a reply with mail_draft if one is needed.";
      const text = buildSessionPrompt({
        mailThreadId: thread.id,
        subject: thread.subject,
        participants: [...new Set(messages.map((message) => message.from.address))].join(", "),
        transcript,
        related,
        emailMd: [
          emailMd,
          edits.length > 0
            ? `How the user edited earlier AI drafts (match the "after" style):\n${edits.map((edit) => `before: ${edit.before}\nafter: ${edit.after}`).join("\n\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        request,
      });
      const launched = yield* launcher
        .launch({
          commandId: CommandId.make(`mail:session:${yield* uuid}`),
          projectId,
          title: thread.subject || "Email",
          titleRenamed: true,
          modelSelection,
          // Mail text can try to steer the agent; commands and edits wait for the user.
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { text, attachments: [] },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError(
            () => new MailError({ code: "unavailable", message: "Could not start the mail chat." }),
          ),
        );
      yield* store.setChatThread(thread.id, launched.threadId);
      yield* store.patchThread(thread.id, {
        state: "working",
        stateAt: now,
        workingReason: "drafting",
      });
      yield* engine.publishThreads([thread.id]);
      return { projectId, threadId: launched.threadId, created: true };
    },
    sqlSafe,
  );

  const accountView = (accountId: MailAccountId) =>
    engine.status.pipe(
      Effect.flatMap((status) => {
        const account = status.accounts.find((entry) => entry.id === accountId);
        return account ? Effect.succeed(account) : Effect.fail(notFound("account"));
      }),
    );

  const verify = (connection: MailAccountConnection, password: string) =>
    Effect.tryPromise({
      try: () =>
        verifyLogin({
          host: connection.imapHost,
          port: connection.imapPort,
          secure: connection.imapTls,
          user: connection.username,
          password,
        }),
      catch: (error) => {
        const failure = classifyImapError(error);
        return new MailError({
          code: failure.kind === "auth" ? "auth_failed" : "connection_failed",
          message:
            failure.kind === "auth"
              ? `The server refused the login: ${failure.detail}`
              : `Could not reach ${connection.imapHost}: ${failure.detail}`,
        });
      },
    });

  const addAccount: MailService["Service"]["addAccount"] = Effect.fn("MailService.addAccount")(
    function* (input) {
      const email = input.email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        return yield* invalid("Enter a full email address.");
      const existing = (yield* store.listAccounts).find((account) => account.email === email);
      if (existing) return yield* invalid("That account is already connected.");
      const connection = input.connection ?? presetFor(email);
      if (connection === null) {
        return yield* invalid("Enter the IMAP and SMTP server settings for this provider.");
      }
      // Gmail app passwords are shown with spaces; the server wants them without.
      const password = input.appPassword.replace(/\s+/g, "");
      const verified = yield* verify(connection, password);
      const id = MailAccountId.make(`acct-${(yield* uuid).slice(0, 12)}`);
      const credentialStore = yield* credentials
        .put(id, password)
        .pipe(
          Effect.mapError(
            () =>
              new MailError({ code: "unavailable", message: "Could not save the app password." }),
          ),
        );
      yield* store.insertAccount({
        id,
        email,
        displayName: input.displayName?.trim() || email.split("@")[0]!,
        provider: verified.gmail ? "gmail" : "imap",
        imapHost: connection.imapHost,
        imapPort: connection.imapPort,
        imapTls: connection.imapTls,
        smtpHost: connection.smtpHost,
        smtpPort: connection.smtpPort,
        smtpTls: connection.smtpTls,
        username: connection.username,
        credentialStore,
        status: "connecting",
        statusDetail: null,
        lastSyncAt: null,
        backfillPausedUntil: null,
        createdAt: yield* nowIso,
      });
      yield* readEmailMdText;
      yield* sync.start(id);
      yield* engine.publishStatus;
      return yield* accountView(id);
    },
    sqlSafe,
  );

  const updateAccount: MailService["Service"]["updateAccount"] = Effect.fn(
    "MailService.updateAccount",
  )(function* (input) {
    const account = yield* store.getAccount(input.accountId);
    if (account === null) return yield* notFound("account");
    if (input.appPassword !== undefined) {
      const password = input.appPassword.replace(/\s+/g, "");
      yield* verify(
        {
          imapHost: account.imapHost,
          imapPort: account.imapPort,
          imapTls: account.imapTls,
          smtpHost: account.smtpHost,
          smtpPort: account.smtpPort,
          smtpTls: account.smtpTls,
          username: account.username,
        },
        password,
      );
      const credentialStore = yield* credentials
        .put(account.id, password)
        .pipe(
          Effect.mapError(
            () =>
              new MailError({ code: "unavailable", message: "Could not save the app password." }),
          ),
        );
      yield* store.updateAccount(account.id, {
        credentialStore,
        status: "connecting",
        statusDetail: null,
      });
    }
    if (input.displayName !== undefined && input.displayName.trim()) {
      yield* store.updateAccount(account.id, { displayName: input.displayName.trim() });
    }
    if (input.appPassword !== undefined) yield* sync.start(account.id);
    yield* engine.publishStatus;
    return yield* accountView(account.id);
  }, sqlSafe);

  const removeAccount: MailService["Service"]["removeAccount"] = Effect.fn(
    "MailService.removeAccount",
  )(function* (accountId) {
    const account = yield* store.getAccount(accountId);
    if (account === null) return;
    yield* sync.stop(accountId);
    yield* credentials.remove(accountId, account.credentialStore).pipe(Effect.ignore);
    const threads = yield* store.sql<{
      id: string;
    }>`SELECT id FROM mail_threads WHERE account_id = ${accountId}`;
    yield* store.deleteAccount(accountId);
    yield* engine.publishRemoved(threads.map((row) => row.id as MailThreadId));
    yield* engine.publishStatus;
  }, sqlSafe);

  const syncNow: MailService["Service"]["syncNow"] = Effect.fn("MailService.syncNow")(function* (
    accountId,
  ) {
    const accounts = yield* store.listAccounts;
    for (const account of accounts) {
      if (accountId !== undefined && account.id !== accountId) continue;
      // A stopped loop (auth failure, paused) restarts; a live one just wakes.
      if (
        account.status === "auth_failed" ||
        account.status === "paused" ||
        account.status === "error" ||
        account.status === "offline"
      ) {
        yield* sync.start(account.id);
      } else {
        yield* sync.wake(account.id);
      }
    }
  }, sqlSafe);

  const updateSettings: MailService["Service"]["updateSettings"] = Effect.fn(
    "MailService.updateSettings",
  )(function* (input) {
    const current = yield* engine.settings;
    const next: MailSettings = {
      ...current,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
    };
    yield* engine.putSettings(next);
    if (current.syncEnabled !== next.syncEnabled) {
      for (const account of yield* store.listAccounts) {
        if (next.syncEnabled) yield* sync.start(account.id);
        else
          yield* sync
            .stop(account.id)
            .pipe(Effect.andThen(store.updateAccount(account.id, { status: "paused" })));
      }
    }
    const unblocked =
      (current.defaultModelSelection === null && next.defaultModelSelection !== null) ||
      current.weeklyTokenCap !== next.weeklyTokenCap;
    if (unblocked) {
      yield* store.requeueWaitingTriage;
      yield* Queue.offer(engine.triageSignal, undefined);
    }
    yield* engine.publishStatus;
    return next;
  }, sqlSafe);

  const listTrust: MailService["Service"]["listTrust"] = store.listTrust.pipe(
    Effect.map((rows) => ({
      records: rows.map(({ record, updatedAt }): MailTrustRecord => ({
        key: record.key,
        kind: record.kind,
        label: record.key.replace(/^(sender|category):/, ""),
        reason: record.reason,
        approvals: record.approvals,
        rejections: record.rejections,
        streak: record.streak,
        trust: record.trust,
        explicit: record.explicit,
        updatedAt,
      })),
    })),
    sqlSafe,
  );

  const setTrust: MailService["Service"]["setTrust"] = Effect.fn("MailService.setTrust")(function* (
    input,
  ) {
    const kind = input.key.startsWith("category:")
      ? "category"
      : input.key.startsWith("sender:")
        ? "sender"
        : null;
    if (kind === null) return yield* invalid("Unknown trust key.");
    const now = yield* nowIso;
    const records = yield* store.getTrust([input.key]);
    const current = records.get(input.key) ?? emptyRecord(input.key, kind);
    if (input.trust === "reset") yield* store.deleteTrust(input.key);
    else yield* store.putTrust(setLevel(current, input.trust), now);
    yield* store.insertAction({
      at: now,
      actor: "user",
      actorLabel: input.key,
      kind: "trust",
      threadId: null,
      reason: input.trust,
      undo: { trust: [current] },
    });
  }, sqlSafe);

  const readEmailMd: MailService["Service"]["readEmailMd"] = readEmailMdText.pipe(
    Effect.map((content) => ({ path: emailMdPath, content })),
  );

  const writeEmailMd: MailService["Service"]["writeEmailMd"] = (content) =>
    fs.makeDirectory(store.workspaceDir, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(emailMdPath, content)),
      Effect.as({ path: emailMdPath, content }),
      Effect.mapError(
        () => new MailError({ code: "unavailable", message: "Could not save EMAIL.md." }),
      ),
    );

  const dryRunRule: MailService["Service"]["dryRunRule"] = Effect.fn("MailService.dryRunRule")(
    function* (rule) {
      const threads = yield* store.sql<
        Record<string, unknown>
      >`SELECT id, subject, from_name, from_address, state
        FROM mail_threads ORDER BY last_message_at DESC LIMIT 2000`;
      const matches: Array<MailDryRunRuleResult["matches"][number]> = [];
      for (const row of threads) {
        const fromAddress = String(row.from_address ?? "");
        let listId: string | null = null;
        if (rule.match.listId) {
          const latest = yield* store.latestMessage(String(row.id) as MailThreadId);
          listId = latest?.listId ?? null;
        }
        if (
          !matchesRule(
            { ...rule, enabled: true },
            { fromAddress, subject: String(row.subject ?? ""), listId },
          )
        )
          continue;
        matches.push({
          threadId: String(row.id) as MailThreadId,
          subject: String(row.subject ?? ""),
          from: String(row.from_name || row.from_address || ""),
          state: String(row.state) as MailThreadRow["state"],
        });
      }
      return { matches: matches.slice(0, 50), total: matches.length };
    },
    sqlSafe,
  );

  const seedVoice: MailService["Service"]["seedVoice"] = Effect.gen(function* () {
    const settings = yield* engine.settings;
    if (settings.defaultModelSelection === null) return yield* invalid("Pick a mail model first.");
    const samples = (yield* store.sentSamples(15))
      .map((message) => cleanForModel(message.body ?? "", 800))
      .filter((text) => text.length > 20);
    if (samples.length === 0) return yield* invalid("No sent mail has synced yet.");
    const prompt = buildVoicePrompt(samples);
    const result = yield* textGeneration
      .generateMailNotes({
        cwd: store.workspaceDir,
        prompt,
        modelSelection: settings.defaultModelSelection,
      })
      .pipe(
        Effect.mapError(
          () =>
            new MailError({
              code: "unavailable",
              message: "The model could not read your sent mail.",
            }),
        ),
      );
    yield* recordUsage(
      "voice",
      settings.defaultModelSelection.model,
      prompt.length + result.notes.length,
      samples.length,
    );
    yield* engine.publishStatus;
    return { notes: result.notes.trim() };
  }).pipe(sqlSafe);

  const dismissRecap: MailService["Service"]["dismissRecap"] = (date) =>
    store.setKv("recap-dismissed", date).pipe(Effect.andThen(engine.publishStatus), sqlSafe);

  yield* store.requeueWaitingTriage.pipe(Effect.ignore);
  for (const account of yield* store.listAccounts.pipe(Effect.orElseSucceed(() => []))) {
    yield* sync.start(account.id);
  }
  yield* triageWorker.pipe(Effect.forkScoped);
  yield* Queue.offer(engine.triageSignal, undefined);
  yield* tick.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);

  return MailService.of({
    subscribe: engine.subscribe.pipe(Stream.mapError(() => storeError())),
    getThread,
    listSettled,
    listActive,
    search,
    act,
    undo,
    listActions,
    saveDraft,
    discardDraft,
    sendDraft,
    openSession,
    addAccount,
    updateAccount,
    removeAccount,
    syncNow,
    updateSettings,
    listTrust,
    setTrust,
    readEmailMd,
    writeEmailMd,
    dryRunRule,
    seedVoice,
    dismissRecap,
    drainTriage,
  });
});

export const layer = Layer.effect(MailService, make);

/** The whole mail stack over the server's state directory. */
export const layerLive = layer.pipe(
  Layer.provideMerge(MailSync.layer),
  Layer.provideMerge(MailEngine.layer),
  Layer.provideMerge(MailCredentials.layer),
  Layer.provideMerge(MailStore.layer),
);
