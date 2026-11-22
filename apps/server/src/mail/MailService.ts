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
  type MailMessageBodyInput,
  type MailFormattedBody,
  type MailThreadDetail,
  type MailThreadId,
  type MailThreadRow,
  type MailTrustRecord,
  MessageId,
  type ModelSelection,
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
  MailThreadState,
  MailTrustList,
  MailUpdateAccountInput,
  MailUpdateSettingsInput,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- session receipts need stable ids across server restarts.
import * as NodeCrypto from "node:crypto";
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
import * as TxReentrantLock from "effect/TxReentrantLock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { classifyImapError, verifyLogin } from "./imapSession.ts";
import * as MailCredentials from "./MailCredentials.ts";
import * as MailEngine from "./MailEngine.ts";
import {
  categoryGuardrail,
  matchesRule,
  prefilter,
  type PrefilterResult,
} from "./mailPrefilter.ts";
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
  asksQuestion,
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
  previousTrustFields,
  recordApproval,
  recordRejection,
  reverseTrust,
  senderKey,
  setLevel,
  type TrustDecision,
  type TrustRecord,
  type TrustUndo,
  type TrustUndoEntry,
} from "./mailTrust.ts";
import { buildRaw, classifySmtpError, sendRaw } from "./smtpSend.ts";

type MailStreamEventType = MailStreamEvent;

const L1_BATCH = 12;
const L1_TEXT_CHARS = 1_200;
const GUARDRAIL_TEXT_CHARS = 200_000;
const TRIAGE_RETRY_MINUTES = 10;
const SESSION_MESSAGE_CHARS = 3_000;
const SEND_DEDUPE_MS = 10 * 60_000;
const DRAFT_CHANGED = "The draft changed after you reviewed it. Review it again before sending.";
const MAYBE_SENT = "It may have been sent; check Sent before sending again.";

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
const modelConfidence = (confidence: number) =>
  Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;

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

const toJson = (value: unknown): string => JSON.stringify(value);

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
    readonly arrivals: MailEngine.MailEngine["Service"]["arrivals"];
    readonly subscribe: Stream.Stream<MailStreamEventType, MailError>;
    readonly getMessageBody: (
      input: MailMessageBodyInput,
    ) => Effect.Effect<MailFormattedBody | null, MailError>;
    readonly getThread: (threadId: MailThreadId) => Effect.Effect<MailThreadDetail, MailError>;
    readonly listSettled: (input: MailListSettledInput) => Effect.Effect<MailThreadPage, MailError>;
    /** Sidebar order: oldest entry first, except Settled, newest first. */
    readonly listThreads: (
      state: MailThreadState,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<MailThreadRow>, MailError>;
    readonly search: (input: MailSearchInput) => Effect.Effect<MailSearchResult, MailError>;
    readonly act: (
      input: MailActInput,
      actor: MailActorInfo,
    ) => Effect.Effect<MailActResult, MailError>;
    readonly undo: (actionId: number) => Effect.Effect<void, MailError>;
    /** An agent's settle proposal: shown like the AI's, settled only when the user approves. */
    readonly propose: (
      input: { readonly threadIds: ReadonlyArray<MailThreadId>; readonly reason: MailSettleReason },
      actor: MailActorInfo,
    ) => Effect.Effect<MailActResult, MailError>;
    readonly listActions: (input: MailListActionsInput) => Effect.Effect<MailActionPage, MailError>;
    readonly saveDraft: (
      input: MailSaveDraftInput,
      actor: MailActorInfo,
    ) => Effect.Effect<MailDraft, MailError>;
    readonly discardDraft: (
      draftId: MailDraftId,
      expectedRevision?: number,
    ) => Effect.Effect<void, MailError>;
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
  // A send can write messages and learned edits after SMTP returns. Removal must wait for it.
  const accountLock = yield* TxReentrantLock.make();
  const changeAccounts = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    TxReentrantLock.withWriteLock(accountLock, operation);
  const stateLock = yield* Semaphore.make(1);
  const commit = stateLock.withPermits(1);
  // Model calls run under this one, never under stateLock, so user actions never wait on a model.
  const triageLock = yield* Semaphore.make(1);

  const emailMdPath = path.join(store.workspaceDir, "EMAIL.md");
  // Mail model calls run in an empty folder: some harnesses keep a read tool enabled.
  const modelDir = path.join(store.mailDir, "model");
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

  /** Applies an approval or rejection to both keys and returns what undo needs to reverse it. */
  const updateTrust = Effect.fn("MailService.updateTrust")(function* (
    thread: MailStore.ThreadRecord,
    change:
      | { readonly type: "approve"; readonly reason: MailSettleReason }
      | { readonly type: "reject" },
  ) {
    const settings = yield* engine.settings;
    const now = yield* nowIso;
    const { keys, sender, category } = yield* loadTrust(thread);
    const entries: Array<TrustUndoEntry> = [];
    const apply = Effect.fnUntraced(function* (
      record: TrustRecord | null,
      key: string,
      kind: TrustRecord["kind"],
    ) {
      const before = record ?? emptyRecord(key, kind);
      const after =
        change.type === "approve"
          ? recordApproval(before, {
              threshold: settings.trustThreshold,
              reason: change.reason,
              bulk: thread.bulk,
            })
          : recordRejection(before);
      yield* store.putTrust(after, now);
      entries.push({ key, kind, clock: yield* store.advanceTrustClock(key, "feedback") });
    });
    yield* apply(sender, keys.sender, "sender");
    if (keys.category) yield* apply(category, keys.category, "category");
    return { effect: change.type, entries } satisfies TrustUndo;
  });

  const recordThreadAction = Effect.fn("MailService.recordThreadAction")(function* (
    thread: MailStore.ThreadRecord,
    patch: MailStore.ThreadStatePatch,
    action: Pick<MailStore.ActionRecord, "at" | "actor" | "actorLabel" | "kind" | "reason">,
    undo: NonNullable<MailStore.ActionRecord["undo"]> = {},
  ) {
    const change = yield* store.patchForAction(thread, patch);
    if (!change && Object.keys(undo).length === 0) return null;
    return yield* store.insertAction({
      ...action,
      threadId: thread.id,
      undo: { ...undo, ...(change ? { thread: change } : {}) },
    });
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
    const targets = yield* store.mirrorTargets(thread.accountId, thread.id, kind);
    if (targets.length === 0) return;
    yield* sync.enqueue(thread.accountId, { kind, threadId: thread.id, targets });
    return {
      kind: kind === "archive" ? "unarchive" : "archive",
      targets,
    } satisfies MailStore.MirrorUndo;
  });

  const actOne = Effect.fn("MailService.actOne")(function* (
    thread: MailStore.ThreadRecord,
    action: MailThreadAction,
    actor: MailActorInfo,
    now: string,
  ) {
    let patch: MailStore.ThreadStatePatch | null = null;
    let trust: TrustUndo | null = null;
    let kind: MailActionKind = "settle";
    let reason: string | null = null;
    let mirrorUndo: MailStore.MirrorUndo | undefined;
    let read: NonNullable<MailStore.ActionRecord["undo"]>["read"];
    switch (action.type) {
      case "settle":
      case "approve": {
        if (thread.state === "settled") return null;
        if (
          action.type === "approve" &&
          (thread.state !== "active" ||
            thread.suggestionReason === null ||
            action.revisions[thread.id] !== (thread.workflowVersion ?? "initial"))
        ) {
          return yield* invalid("The suggestion changed. Review the current mail before settling.");
        }
        const settleReason =
          action.type === "approve"
            ? thread.suggestionReason!
            : (action.reason ?? thread.suggestionReason ?? "done");
        patch = settledPatch(now, settleReason, actor.actor);
        // Only agreeing with a pending suggestion counts toward graduation; settling mail the AI
        // never flagged says nothing about whether it may settle that sender alone.
        if (actor.actor === "user" && thread.suggestionReason !== null) {
          trust = yield* updateTrust(thread, { type: "approve", reason: settleReason });
        }
        kind = action.type === "approve" ? "approve" : "settle";
        reason = settleReason;
        mirrorUndo = yield* mirror(thread, "archive");
        break;
      }
      case "keep":
      case "unsettle": {
        const wasAi =
          thread.state === "settled" && (thread.settledBy === "ai" || thread.settledBy === "rule");
        if (
          actor.actor === "user" &&
          ((action.type === "keep" && thread.suggestionReason !== null) || wasAi)
        ) {
          trust = yield* updateTrust(thread, { type: "reject" });
        }
        patch = {
          ...(thread.state === "active" ? {} : activePatch(now)),
          suggestionReason: null,
          suggestionConfidence: null,
        };
        kind = action.type === "keep" ? "reject" : "unsettle";
        if (thread.state === "settled") mirrorUndo = yield* mirror(thread, "unarchive");
        break;
      }
      case "pin":
        if (thread.pinnedAt !== null) return null;
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
        const { keys, sender } = yield* loadTrust(thread);
        const current = sender ?? emptyRecord(keys.sender, "sender");
        const next: TrustRecord = { ...setLevel(current, "never"), reason: "noise" };
        yield* store.putTrust(next, now);
        trust = {
          effect: "level",
          entry: {
            key: keys.sender,
            kind: "sender",
            clock: yield* store.advanceTrustClock(keys.sender, "level"),
          },
          before: previousTrustFields(sender, next),
        };
        patch = settledPatch(now, "noise", actor.actor);
        kind = "never_show";
        reason = "noise";
        mirrorUndo = yield* mirror(thread, "archive");
        break;
      }
      case "mark_read": {
        const token = yield* uuid;
        const messages = yield* store.markMessagesRead(thread.id, token);
        if (messages.length === 0) return null;
        const messageIds = messages.map(({ id }) => id);
        const targets = (yield* store.messageTargets(thread.id, messageIds)).map(
          ({ id, identity }) => ({ id, identity }),
        );
        yield* store.refreshUnread(thread.id);
        yield* sync.enqueue(thread.accountId, {
          kind: "seen",
          threadId: thread.id,
          seen: true,
          targets,
        });
        read = { token, count: messages.length, targets };
        patch = {};
        kind = "mark_read";
        break;
      }
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
        kind = "wait_for_reply";
        reason = "waiting";
        break;
    }
    return yield* recordThreadAction(
      thread,
      patch,
      {
        at: now,
        actor: actor.actor,
        actorLabel: actor.label ?? null,
        kind,
        reason,
      },
      {
        ...(trust ? { trust } : {}),
        ...(mirrorUndo ? { mirror: mirrorUndo } : {}),
        ...(read ? { read } : {}),
      },
    );
  });

  const act: MailService["Service"]["act"] = Effect.fn("MailService.act")(
    function* (input, actor) {
      const now = yield* nowIso;
      const threads = yield* store.getThreads(input.threadIds);
      if (threads.length === 0) return yield* notFound("email");
      const actionIds: Array<number> = [];
      for (const thread of threads) {
        const id = yield* actOne(thread, input.action, actor, now);
        if (id !== null) actionIds.push(id);
      }
      return { actionIds };
    },
    store.transaction,
    commit,
    (effect, input) =>
      effect.pipe(
        Effect.tap(() => engine.publishThreads(input.threadIds)),
        Effect.tap(() => engine.publishStatus),
      ),
    sqlSafe,
  );

  const staleUndo = () => invalid("This item changed after that action.");

  const undo: MailService["Service"]["undo"] = Effect.fn("MailService.undo")(
    function* (actionId) {
      const action = yield* store.getAction(actionId);
      if (action === null) return yield* notFound("action");
      const history = action.undo;
      if (!history || action.undoneAt !== null)
        return yield* invalid("That action cannot be undone.");
      const now = yield* nowIso;
      const thread = action.threadId === null ? null : yield* store.getThread(action.threadId);
      if (action.threadId !== null && thread === null) return yield* staleUndo();
      if (history.thread && thread) {
        const { before, after, version } = history.thread;
        if (
          version !== ("pinnedAt" in after ? thread.pinVersion : thread.workflowVersion) ||
          Object.entries(after).some(
            ([key, value]) => thread[key as keyof MailStore.ThreadStatePatch] !== value,
          )
        ) {
          return yield* staleUndo();
        }
        yield* store.patchThread(thread.id, before);
      }
      if (history.draft) {
        const { id, revision, before } = history.draft;
        const draft = yield* store.getDraft(id);
        if (draft?.status !== "draft" || draft.revision !== revision) return yield* staleUndo();
        if (before === null) yield* store.deleteDraft(id);
        else yield* store.saveDraftContent({ ...draft, ...before, updatedAt: now });
      }
      if (history.discardedDraft) {
        const draft = history.discardedDraft;
        if (yield* store.getDraft(draft.id)) return yield* staleUndo();
        yield* store.saveDraftContent({ ...draft, revision: draft.revision + 1, updatedAt: now });
      }
      if (history.read && thread) {
        const changed = yield* store.undoMessagesRead(thread.id, history.read.token);
        if (changed.length !== history.read.count) return yield* staleUndo();
        yield* store.refreshUnread(thread.id);
        yield* sync.enqueue(thread.accountId, {
          kind: "seen",
          threadId: thread.id,
          seen: false,
          targets: history.read.targets,
        });
      }
      if (history.trust?.effect === "level") {
        const { entry, before } = history.trust;
        if ((yield* store.trustClock(entry.key)).revision !== entry.clock.revision)
          return yield* staleUndo();
        if (before) {
          const record =
            (yield* store.getTrust([entry.key])).get(entry.key) ??
            emptyRecord(entry.key, entry.kind);
          yield* store.putTrust({ ...record, ...before }, now);
        } else yield* store.deleteTrust(entry.key);
        yield* store.advanceTrustClock(
          entry.key,
          action.reason === "reset" || !before ? "reset" : "level",
        );
      } else if (history.trust) {
        const { effect, entries } = history.trust;
        const records = yield* store.getTrust(entries.map((entry) => entry.key));
        for (const entry of entries) {
          const latest = yield* store.trustClock(entry.key);
          if (entry.clock.reset !== latest.reset) continue;
          const current = records.get(entry.key) ?? emptyRecord(entry.key, entry.kind);
          yield* store.putTrust(reverseTrust(effect, current, entry.clock, latest), now);
          yield* store.advanceTrustClock(entry.key, "feedback");
        }
      }
      if (thread && history.mirror && (yield* engine.settings).serverMirroring) {
        yield* sync.enqueue(thread.accountId, { ...history.mirror, threadId: thread.id });
      }
      yield* store.markActionUndone(actionId, now);
      return action.threadId;
    },
    store.transaction,
    commit,
    Effect.tap((id) => (id === null ? Effect.void : engine.publishThreads([id]))),
    Effect.tap(() => engine.publishStatus),
    Effect.asVoid,
    sqlSafe,
  );

  const propose: MailService["Service"]["propose"] = Effect.fn("MailService.propose")(
    function* (input, actor) {
      const at = yield* nowIso;
      const actionIds: Array<number> = [];
      for (const thread of yield* store.getThreads(input.threadIds)) {
        if (thread.state === "settled") continue;
        const id = yield* recordThreadAction(
          thread,
          { suggestionReason: input.reason, suggestionConfidence: 1 },
          {
            at,
            actor: actor.actor,
            actorLabel: actor.label ?? null,
            kind: "propose",
            reason: input.reason,
          },
        );
        if (id !== null) actionIds.push(id);
      }
      return { actionIds };
    },
    store.transaction,
    commit,
    (effect, input) => effect.pipe(Effect.tap(() => engine.publishThreads(input.threadIds))),
    sqlSafe,
  );

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
        ? yield* store.relatedThreads(thread.accountId, thread.fromAddress, threadId, 5)
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

  const rowsWithDrafts = Effect.fn("MailService.rowsWithDrafts")(function* (
    threads: ReadonlyArray<MailStore.ThreadRecord>,
  ) {
    const drafts = yield* store.threadsWithDrafts(threads.map((thread) => thread.id));
    return threads.map((thread) => MailStore.threadRow(thread, drafts.has(thread.id)));
  });

  const listSettled: MailService["Service"]["listSettled"] = Effect.fn("MailService.listSettled")(
    function* (input) {
      const page = yield* store.settledPage({
        before: input.before,
        reason: input.reason,
        byAi: input.byAi,
        limit: input.limit ?? 50,
      });
      return {
        threads: yield* rowsWithDrafts(page.threads),
        hasMore: page.hasMore,
      };
    },
    sqlSafe,
  );

  const listThreads: MailService["Service"]["listThreads"] = Effect.fn("MailService.listThreads")(
    (state, limit) => store.threadsByState(state, limit).pipe(Effect.flatMap(rowsWithDrafts)),
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

  /** Mail that arrived after the snapshot was read gets its own triage; this verdict is stale. */
  const isFresh = (seen: MailStore.ThreadRecord, current: MailStore.ThreadRecord | null) =>
    current !== null &&
    current.lastMessageAt === seen.lastMessageAt &&
    current.incomingCount === seen.incomingCount;

  const setTriageIfFresh = (
    seen: MailStore.ThreadRecord,
    patch: Parameters<MailStore.MailStore["Service"]["setTriage"]>[1],
  ) =>
    store.transaction(
      store
        .getThread(seen.id)
        .pipe(
          Effect.flatMap((current) =>
            isFresh(seen, current) ? store.setTriage(seen.id, patch) : Effect.void,
          ),
        ),
    );

  const applyDecision = Effect.fn("MailService.applyDecision")(function* (
    seen: MailStore.ThreadRecord,
    input: {
      readonly verdict: MailStore.ThreadVerdict;
      readonly prefiltered: PrefilterResult;
      readonly line: string;
      readonly suggestedAction: string | null;
      readonly category: MailCategory;
      readonly guardrail: PrefilterResult["guardrail"];
      readonly injection: boolean;
      readonly suggestOnly: boolean;
    },
  ) {
    const now = yield* nowIso;
    const thread = yield* store.getThread(seen.id);
    if (thread === null || !isFresh(seen, thread)) return;
    const guardrail = input.guardrail;
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
    // The user may have moved it while L1 ran; their choice wins.
    if (thread.state !== "active" || thread.pinnedAt !== null) return;
    const trust = yield* loadTrust({ fromAddress: thread.fromAddress, category: input.category });
    const reason = SETTLE_REASONS.has(input.verdict.reason as MailSettleReason)
      ? (input.verdict.reason as MailSettleReason)
      : null;
    const decided = decide({
      verdict: { decision: input.verdict.decision, reason, confidence: input.verdict.confidence },
      guardrail,
      sender: trust.sender,
      category: trust.category,
      rule: input.prefiltered.rule,
    });
    const decision: TrustDecision =
      decided.type === "auto_settle" && decided.via !== "never_show" && input.suggestOnly
        ? { type: "suggest", reason: decided.reason, confidence: input.verdict.confidence }
        : decided;
    if (decision.type === "auto_settle") {
      const by: MailActor =
        decision.via === "rule" || decision.via === "never_show" ? "rule" : "ai";
      const entries: Array<TrustUndoEntry> = [];
      for (const [key, kind] of [
        [trust.keys.sender, "sender"],
        [trust.keys.category, "category"],
      ] as const) {
        if (key) entries.push({ key, kind, clock: yield* store.trustClock(key) });
      }
      const mirrorUndo = yield* mirror(thread, "archive");
      yield* recordThreadAction(
        thread,
        settledPatch(now, decision.reason, by),
        {
          at: now,
          actor: by,
          actorLabel: null,
          kind: "settle",
          reason: decision.reason,
        },
        { trust: { effect: "ai_settle", entries }, ...(mirrorUndo ? { mirror: mirrorUndo } : {}) },
      );
    } else {
      const suggestion = decision.type === "suggest" ? decision : null;
      yield* recordThreadAction(
        thread,
        {
          suggestionReason: suggestion?.reason ?? null,
          suggestionConfidence: suggestion?.confidence ?? null,
        },
        {
          at: now,
          actor: "ai",
          actorLabel: null,
          kind: suggestion ? "propose" : "reject",
          reason: suggestion?.reason ?? null,
        },
      );
    }
  }, store.transaction);

  interface Prepared {
    readonly thread: MailStore.ThreadRecord;
    readonly text: string;
    readonly prefiltered: PrefilterResult;
    readonly repliedTo: boolean;
    readonly asksQuestion: boolean;
    readonly bodyMissing: boolean;
    readonly item: TriageItem;
  }

  const prepare = Effect.fn("MailService.prepare")(function* (
    thread: MailStore.ThreadRecord,
    settings: MailSettings,
  ) {
    const messages = yield* store.threadMessages(thread.id, 2);
    const newest = messages.at(-1);
    if (newest === undefined) return null;
    const latest = newest.outgoing
      ? ((yield* store.latestMessage(thread.id, true)) ?? newest)
      : newest;
    // Sync fetches every pending body (or marks it unavailable) and then wakes triage again.
    if (latest.bodyState === "pending") return "wait" as const;
    const account = yield* store.getAccount(thread.accountId);
    const me = account?.email.toLowerCase() ?? "";
    // Guardrails read the whole message; only the model's copy is cut short.
    const full = cleanForModel(latest.body ?? "", GUARDRAIL_TEXT_CHARS);
    const text =
      full.length <= L1_TEXT_CHARS ? full : `${full.slice(0, L1_TEXT_CHARS).trimEnd()} …`;
    const replied = yield* store.repliedToAddresses(thread.accountId, [latest.from.address]);
    const toMe = latest.to.some((entry) => entry.address === me);
    const prefiltered = prefilter(
      {
        fromAddress: latest.from.address,
        fromName: latest.from.name,
        subject: latest.subject,
        text: full,
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
        ? `${thread.messageCount - 1} earlier messages; last from ${messages.at(-2)!.outgoing ? "the user" : messages.at(-2)!.from.name || messages.at(-2)!.from.address}: ${firstLine(messages.at(-2)!.body ?? "", 100)}`
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
      asksQuestion: asksQuestion(latest.subject) || asksQuestion(full),
      bodyMissing: latest.bodyState !== "loaded" || full.trim().length === 0,
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
      .generateMailTriage({ cwd: modelDir, prompt, modelSelection: selection })
      .pipe(Effect.timeout("3 minutes"));
    const outputChars = toJson(result).length;
    yield* recordUsage(kind, selection.model, prompt.length + outputChars, batch.length);
    const byId = new Map(
      result.verdicts.map(
        (verdict) =>
          [verdict.id, { ...verdict, confidence: modelConfidence(verdict.confidence) }] as const,
      ),
    );
    return batch.map((entry, index) => ({ entry, verdict: byId.get(`e${index + 1}`) ?? null }));
  });

  const triageRound = Effect.gen(function* () {
    const ids = yield* store.pendingTriage(L1_BATCH * 4);
    if (ids.length === 0) return false;
    const settings = yield* engine.settings;
    const threads = yield* store.getThreads(ids);
    const forModel: Array<Prepared> = [];
    let progressed = false;
    for (const thread of threads) {
      const prepared = yield* prepare(thread, settings);
      if (prepared === "wait") continue;
      progressed = true;
      if (prepared === null) {
        yield* setTriageIfFresh(thread, { triageState: "done" });
        continue;
      }
      const trust = yield* loadTrust({
        fromAddress: thread.fromAddress,
        category: prepared.prefiltered.category,
      });
      const familiarMail =
        !prepared.asksQuestion &&
        (trust.category?.approvals ?? 0) > 0 &&
        canSkipModel({
          sender: trust.sender,
          guardrail: prepared.prefiltered.guardrail,
          bulk: prepared.prefiltered.bulk,
        });
      const skip =
        prepared.prefiltered.rule !== null ||
        trust.sender?.trust === "never" ||
        (trust.sender?.trust === "auto" ? familiarMail : prepared.prefiltered.verdict !== null);
      if (skip) {
        const fromMemory = trust.sender?.trust === "auto" || trust.sender?.trust === "never";
        const ruleVerdict = prepared.prefiltered.verdict;
        yield* commit(
          applyDecision(thread, {
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
            line: firstLine(prepared.text) || thread.subject,
            suggestedAction: null,
            category: prepared.prefiltered.category,
            guardrail: prepared.prefiltered.guardrail,
            injection: looksLikeInstructionsToAi(prepared.text),
            suggestOnly: prepared.bodyMissing,
          }),
        );
        continue;
      }
      forModel.push(prepared);
    }
    const selection = settings.defaultModelSelection;
    for (let start = 0; start < forModel.length; start += L1_BATCH) {
      const batch = forModel.slice(start, start + L1_BATCH);
      const { capped } = yield* engine.usage;
      if (capped || selection === null) {
        for (const prepared of batch) {
          yield* setTriageIfFresh(prepared.thread, {
            line: firstLine(prepared.text) || prepared.thread.subject,
            category: prepared.prefiltered.category,
            guardrail: prepared.prefiltered.guardrail,
            bulk: prepared.prefiltered.bulk,
            triageState: capped ? "capped" : "waiting_model",
            injection: looksLikeInstructionsToAi(prepared.text),
          });
        }
        continue;
      }
      const results = yield* runModel(batch, selection, "l1").pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Mail L1 batch failed; threads wait for the next try.").pipe(
            Effect.annotateLogs({ count: batch.length, cause: String(cause).slice(0, 200) }),
            Effect.andThen(
              Effect.forEach(batch, (entry) =>
                setTriageIfFresh(entry.thread, { triageState: "waiting_model" }),
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
        escalate !== null && needsEscalation.length > 0 && !(yield* engine.usage).capped
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
        const prepared = result.entry;
        const initial = result.verdict;
        if (initial === null) {
          yield* setTriageIfFresh(prepared.thread, { triageState: "waiting_model" });
          continue;
        }
        const better = escalatedBy.get(prepared.thread.id);
        const verdict = better ?? initial;
        const modelCategory = MAIL_CATEGORIES.has(verdict.category as MailCategory)
          ? (verdict.category as MailCategory)
          : "other";
        const category =
          prepared.prefiltered.category === "person" ||
          prepared.prefiltered.category === "notification"
            ? modelCategory
            : prepared.prefiltered.category;
        yield* commit(
          applyDecision(prepared.thread, {
            verdict: {
              decision: verdict.decision,
              reason: verdict.reason,
              confidence: verdict.confidence,
              source: better ? "escalated" : "model",
            },
            prefiltered: prepared.prefiltered,
            line:
              verdict.summary.trim().slice(0, 140) ||
              firstLine(prepared.text) ||
              prepared.thread.subject,
            suggestedAction: verdict.action.trim().slice(0, 40) || null,
            category,
            guardrail:
              categoryGuardrail(verdict.category) ??
              categoryGuardrail(initial.category) ??
              prepared.prefiltered.guardrail ??
              (verdict.urgent || initial.urgent ? "urgent" : null),
            injection: verdict.injection || looksLikeInstructionsToAi(prepared.text),
            suggestOnly:
              prepared.bodyMissing ||
              initial.confidence < LOW_CONFIDENCE ||
              (prepared.repliedTo && !better),
          }),
        );
      }
    }
    yield* engine.publishThreads(threads.map((thread) => thread.id));
    yield* engine.publishStatus;
    return progressed;
  }).pipe(Effect.withSpan("MailService.triageRound"));

  const drainTriage = Effect.gen(function* () {
    let more = true;
    while (more) {
      more = yield* triageLock
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
        const observe = Effect.fn("MailService.recordTimedAction")(function* (
          seen: MailStore.ThreadRecord,
          patch: MailStore.ThreadStatePatch,
          kind: "returned" | "nudge",
          reason: string,
        ) {
          const current = yield* store.getThread(seen.id);
          if (
            !current ||
            current.workflowVersion !== seen.workflowVersion ||
            current.chatThreadId !== seen.chatThreadId
          )
            return;
          yield* store.patchThread(seen.id, patch);
          // The deadline or idle chat still applies on the next tick.
          yield* store.insertAction({
            at: iso,
            actor: "mail",
            actorLabel: null,
            kind,
            reason,
            threadId: seen.id,
            undo: null,
          });
          changed.push(seen.id);
        }, store.transaction);
        for (const thread of yield* store.dueSnoozes(iso)) {
          yield* observe(thread, activePatch(iso), "returned", "snooze");
        }
        const waitingCutoff = isoBefore(now, settings.nudgeWaitingDays);
        for (const thread of yield* store.repliedWaiting(waitingCutoff)) {
          // Follow-up nudge: the user wrote last and nobody answered.
          const nudge = `waiting:${settings.nudgeWaitingDays}`;
          yield* observe(thread, { ...activePatch(iso), nudge }, "nudge", nudge);
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
            const nudge = `unanswered:${settings.nudgeReplyDays}`;
            yield* observe(thread, { nudge }, "nudge", nudge);
          }
        }
        for (const thread of yield* store.threadsByState("working")) {
          if (thread.workingReason !== "drafting" || thread.chatThreadId === null) continue;
          const shell = yield* threadManagement
            .getThreadShell(ThreadId.make(thread.chatThreadId))
            .pipe(Effect.option);
          // A failed lookup says nothing; only a chat that is gone or idle hands the email back.
          if (Option.isNone(shell)) continue;
          if (
            shell.value === null ||
            (shell.value.activeRunId === null && (shell.value.activityRunStatus ?? null) === null)
          ) {
            yield* observe(
              thread,
              { ...activePatch(iso), stateAt: thread.stateAt },
              "returned",
              "chat",
            );
          }
        }
        if (changed.length > 0) yield* engine.publishThreads(changed);
        yield* engine.refreshChatUsage;
        // Failed or capped triage gets another try; the cap rolls over weekly.
        const minute = Math.floor(DateTime.toEpochMillis(now) / 60_000);
        if (minute % TRIAGE_RETRY_MINUTES === 0 && settings.defaultModelSelection !== null) {
          const usage = yield* engine.usage;
          if (!usage.capped) {
            yield* store.requeueWaitingTriage;
            yield* Queue.offer(engine.triageSignal, undefined);
          }
        }
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
      if (input.draftId && (existing === null || existing.threadId !== thread.id))
        return yield* notFound("draft");
      if (existing !== null && (existing.status === "sending" || existing.status === "sent")) {
        return yield* invalid("That draft was already sent.");
      }
      if (existing && actor.actor !== "user" && input.expectedRevision === undefined) {
        return yield* invalid("Read the draft and pass its current expectedRevision to edit it.");
      }
      if (input.expectedRevision !== undefined && existing?.revision !== input.expectedRevision) {
        return yield* invalid("The draft changed. Review the current version before editing.");
      }
      const id = existing?.id ?? MailDraftId.make(`draft-${yield* uuid}`);
      const saved = yield* store.saveDraftContent({
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
        revision: 0,
      });
      if (saved === null) return yield* invalid("That draft was already sent.");
      const before =
        existing === null
          ? null
          : {
              ...(existing.status !== saved.status ? { status: existing.status } : {}),
              ...(existing.messageId !== saved.messageId ? { messageId: existing.messageId } : {}),
              ...(existing.error !== saved.error ? { error: existing.error } : {}),
              ...(existing.subject !== saved.subject ? { subject: existing.subject } : {}),
              ...(existing.body !== saved.body ? { body: existing.body } : {}),
              ...(toJson(existing.to) !== toJson(saved.to) ? { to: existing.to } : {}),
              ...(toJson(existing.cc) !== toJson(saved.cc) ? { cc: existing.cc } : {}),
            };
      const handBack =
        actor.actor !== "user" && thread.state === "working" && thread.workingReason === "drafting";
      yield* recordThreadAction(
        thread,
        handBack ? { ...activePatch(now), stateAt: thread.stateAt } : {},
        {
          at: now,
          actor: actor.actor,
          actorLabel: actor.label ?? null,
          kind: "draft",
          reason: existing ? "edit" : null,
        },
        { draft: { id, revision: saved.revision, before } },
      );
      return MailStore.draftView(saved);
    },
    store.transaction,
    Effect.tap((draft) => engine.publishThreads([draft.threadId])),
    sqlSafe,
  );

  const discardDraft: MailService["Service"]["discardDraft"] = Effect.fn(
    "MailService.discardDraft",
  )(
    function* (draftId, expectedRevision) {
      const draft = yield* store.getDraft(draftId);
      if (draft === null) return null;
      if (draft.status === "sent" || draft.status === "sending")
        return yield* invalid("That draft was already sent.");
      if (expectedRevision !== undefined && expectedRevision !== draft.revision) {
        return yield* invalid("The draft changed. Review the current version before discarding.");
      }
      yield* store.deleteDraft(draftId);
      yield* store.insertAction({
        at: yield* nowIso,
        actor: "user",
        actorLabel: null,
        kind: "draft",
        reason: "discard",
        threadId: draft.threadId,
        undo: { discardedDraft: draft },
      });
      return draft.threadId;
    },
    store.transaction,
    Effect.flatMap((id) => (id === null ? Effect.void : engine.publishThreads([id]))),
    sqlSafe,
  );

  const sendDraft: MailService["Service"]["sendDraft"] = Effect.fn("MailService.sendDraft")(
    function* (input) {
      const draft = yield* store.getDraft(input.draftId);
      if (draft === null) return yield* notFound("draft");
      if (draft.status === "sent" || draft.status === "sending") return MailStore.draftView(draft);
      if (draft.revision !== input.revision) return yield* invalid(DRAFT_CHANGED);
      if (draft.to.length + draft.cc.length === 0)
        return yield* invalid("Add at least one recipient.");
      const account = yield* store.getAccount(draft.accountId);
      if (account === null) return yield* notFound("account");
      if (account.credentialPending)
        return yield* invalid(account.statusDetail ?? "Finish updating this account first.");
      const now = yield* nowIso;
      const recent = (yield* store.draftsForThread(draft.threadId)).find(
        (other) =>
          other.id !== draft.id &&
          other.status === "sent" &&
          other.body.trim() === draft.body.trim() &&
          other.sentAt !== null &&
          isoMillis(now) - isoMillis(other.sentAt) < SEND_DEDUPE_MS,
      );
      if (recent) return yield* invalid("The same reply was sent a moment ago.");
      // One claim per reviewed revision: a double tap or a retry cannot send twice, and a
      // resend after an unclear failure keeps the first Message-ID.
      const claimed = yield* store.claimDraftForSend(
        draft.id,
        input.revision,
        `<${yield* uuid}@${domainOf(account.email) || "t3.mail"}>`,
        now,
      );
      if (claimed === null) {
        const latest = yield* store.getDraft(draft.id);
        if (latest?.status === "sent" || latest?.status === "sending")
          return MailStore.draftView(latest);
        return yield* invalid(DRAFT_CHANGED);
      }
      const messageId = claimed.messageId ?? "";
      const fail = (message: string, code: "send_failed" | "auth_failed" = "send_failed") =>
        store
          .finishDraftSend(claimed.id, { status: "failed", error: message, at: now })
          .pipe(
            Effect.andThen(engine.publishThreads([claimed.threadId])),
            Effect.andThen(Effect.fail(new MailError({ code, message }))),
          );
      const password = yield* credentials
        .get(account.id, account.credentialStore)
        .pipe(Effect.orElseSucceed(() => null));
      if (password === null)
        return yield* fail("Re-enter the app password for this account.", "auth_failed");
      const last = yield* store.latestMessage(claimed.threadId);
      const correspondent = last?.outgoing
        ? yield* store.latestMessage(claimed.threadId, true)
        : last;
      const outgoing = {
        from: { name: account.displayName, address: account.email },
        to: claimed.to,
        cc: claimed.cc,
        subject: claimed.subject,
        text: claimed.body,
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
          const delivery = await sendRaw(
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
          return { raw, ...delivery };
        },
        catch: (error) => classifySmtpError(error),
      }).pipe(Effect.exit);
      if (sent._tag === "Failure") {
        const failure = sent.cause.reasons.find((reason) => reason._tag === "Fail");
        const info =
          failure && failure._tag === "Fail"
            ? failure.error
            : { auth: false, definite: false, detail: "Sending failed." };
        return yield* fail(
          info.definite ? info.detail : `${info.detail} ${MAYBE_SENT}`,
          info.auth ? "auth_failed" : "send_failed",
        );
      }
      const sentAt = yield* nowIso;
      const sender = correspondent?.from.address.trim().toLowerCase();
      const editSender =
        sender &&
        claimed.originalBody !== null &&
        claimed.originalBody.trim() !== claimed.body.trim() &&
        [...claimed.to, ...claimed.cc].every((address) => address.trim().toLowerCase() === sender)
          ? sender
          : null;
      const { accepted, rejected, raw } = sent.value;
      const partial = rejected.length > 0;
      const deliveryDetail = partial
        ? `SMTP accepted: ${accepted.join(", ")}. SMTP rejected: ${rejected.join(", ")}.`
        : null;
      const originalCc = new Set(claimed.cc.map((entry) => entry.toLowerCase()));
      const remaining = partial
        ? {
            to: rejected.filter((address) => !originalCc.has(address.toLowerCase())),
            cc: rejected.filter((address) => originalCc.has(address.toLowerCase())),
          }
        : undefined;
      const final = yield* store.transaction(
        Effect.gen(function* () {
          const saved = yield* store.finishDraftSend(claimed.id, {
            status: partial ? "failed" : "sent",
            error: deliveryDetail,
            remaining,
            at: sentAt,
            editSender: partial ? null : editSender,
          });
          if (saved === null) return yield* invalid(DRAFT_CHANGED);
          const local = yield* store.upsertMessage({
            accountId: account.id,
            mailbox: "__local",
            uid: yield* store.nextLocalSentUid,
            messageId,
            threadId: claimed.threadId,
            labels: null,
            inInbox: false,
            from: { name: account.displayName, address: account.email },
            to: claimed.to.map((address) => ({ name: "", address })),
            cc: claimed.cc.map((address) => ({ name: "", address })),
            subject: claimed.subject,
            date: sentAt,
            inReplyTo: outgoing.inReplyTo,
            references: outgoing.references,
            seen: true,
            outgoing: true,
            size: claimed.body.length,
            attachments: [],
            listUnsubscribe: false,
            listId: null,
            precedence: null,
            autoSubmitted: null,
            calendar: false,
            textPart: null,
          });
          yield* store.setMessageBody(local.id, claimed.body);
          yield* store.refreshThreadAggregate(claimed.threadId);
          const thread = yield* store.getThread(claimed.threadId);
          if (thread !== null && partial && thread.state !== "active") {
            yield* store.patchThread(thread.id, activePatch(sentAt));
          } else if (thread !== null && !partial && thread.state !== "settled") {
            yield* store.patchThread(thread.id, settledPatch(sentAt, "replied", "user"));
            yield* mirror(thread, "archive");
          }
          yield* store.insertAction({
            at: sentAt,
            actor: "user",
            actorLabel: null,
            kind: "send",
            threadId: claimed.threadId,
            reason: deliveryDetail,
            undo: null,
          });
          if (account.provider !== "gmail") {
            yield* sync.enqueue(account.id, {
              kind: "append_sent",
              raw: raw.toString("base64"),
            });
          }
          return saved;
        }),
      );
      yield* engine.afterBodies([claimed.threadId]);
      yield* engine.publishThreads([claimed.threadId]);
      return MailStore.draftView(final);
    },
    (operation) => TxReentrantLock.withReadLock(accountLock, operation),
    sqlSafe,
  );

  const sessionLock = yield* KeyedLock.make<MailThreadId>();
  const sessionDigest = (...parts: ReadonlyArray<string | null>) =>
    NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  const chatUnavailable = () =>
    new MailError({ code: "unavailable", message: "Could not reach the mail chat." });

  const ensureSessionProject = Effect.gen(function* () {
    const existing = yield* projects.getById(MAIL_SESSION_PROJECT_ID);
    if (Option.isSome(existing)) return;
    yield* readEmailMdText;
    const created = yield* projects.bootstrap({
      commandId: CommandId.make("mail:project:create"),
      projectId: MAIL_SESSION_PROJECT_ID,
      title: "Mail",
      workspaceRoot: store.workspaceDir,
      createWorkspaceRootIfMissing: true,
    });
    if (created.project.id !== MAIL_SESSION_PROJECT_ID) return yield* chatUnavailable();
  });

  const openSession: MailService["Service"]["openSession"] = Effect.fn("MailService.openSession")(
    function* (input) {
      const thread = yield* store.getThread(input.threadId);
      if (thread === null) return yield* notFound("email");
      yield* ensureSessionProject.pipe(
        Effect.mapError(
          () => new MailError({ code: "unavailable", message: "Could not open the Mail project." }),
        ),
      );
      const projectId = MAIL_SESSION_PROJECT_ID;
      const linkedId = thread.chatThreadId === null ? null : ThreadId.make(thread.chatThreadId);
      const shell =
        linkedId === null
          ? null
          : yield* threadManagement.getThreadShell(linkedId).pipe(Effect.mapError(chatUnavailable));
      if (shell && shell.projectId !== projectId) return yield* chatUnavailable();
      // A confirmed deletion starts a new chain. A lost launch result replays the same claim.
      const threadId =
        shell?.id ?? ThreadId.make(`mail-chat-${sessionDigest(thread.id, linkedId)}`);
      const trackingKey = `chat-context:${threadId}`;
      const previous = yield* store.getKv(trackingKey);
      const messages = yield* store.threadMessages(thread.id, 8);
      const transcript = messages
        .map(
          (message) =>
            `From: ${message.outgoing ? "the user" : `${message.from.name} <${message.from.address}>`}\nDate: ${message.date}\nSubject: ${message.subject}\n\n${cleanForModel(message.body ?? "(body not downloaded)", SESSION_MESSAGE_CHARS)}`,
        )
        .join("\n\n---\n\n");
      const revision = sessionDigest(transcript, ...messages.map((message) => String(message.id)));
      const contextSent = previous?.startsWith(`${revision}:`) === true;
      if (shell && contextSent && !input.prompt) return { projectId, threadId, created: false };
      const receipt = sessionDigest(threadId, previous, revision, input.prompt ?? null);
      const messageId = MessageId.make(`${revision}:${receipt}`);
      const related = (yield* store.relatedThreads(
        thread.accountId,
        thread.fromAddress,
        thread.id,
        5,
      ))
        .map((entry) => `- ${entry.lastMessageAt.slice(0, 10)} ${entry.subject} (${entry.state})`)
        .join("\n");
      const emailMd = relevantEmailMd(yield* readEmailMdText, [
        thread.fromName,
        thread.fromAddress,
        domainOf(thread.fromAddress),
      ]);
      const edits =
        thread.lastIncomingAt === null
          ? []
          : yield* store.recentReplyEdits(
              thread.accountId,
              thread.fromAddress.trim().toLowerCase(),
            );
      const request =
        input.prompt ??
        (shell
          ? "Update me on what changed in this email thread."
          : "Read this email thread. Tell me in two lines what it needs from me, then leave a reply draft if one is needed.");
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
      let created = false;
      let send = shell !== null;
      if (shell === null) {
        const modelSelection =
          input.modelSelection ??
          (yield* engine.settings).defaultModelSelection ??
          (yield* serverSettings.getSettings.pipe(Effect.mapError(chatUnavailable)))
            .defaultModelSelection;
        if (!modelSelection) return yield* invalid("Pick a mail model in Settings → Mail first.");
        const launched = yield* launcher
          .launch({
            commandId: CommandId.make(`mail:session:${threadId}`),
            threadId,
            projectId,
            title: thread.subject || "Email",
            titleRenamed: true,
            modelSelection,
            // Mail text can try to steer the agent; commands and edits wait for the user.
            runtimeMode: "approval-required",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { messageId, text, attachments: [] },
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(
            Effect.mapError(
              () =>
                new MailError({ code: "unavailable", message: "Could not start the mail chat." }),
            ),
          );
        created = !launched.resumed;
        // New mail or a different request may have arrived since the unacknowledged launch.
        send =
          launched.resumed &&
          !launched.projection.messages.some((message) =>
            input.prompt ? message.id === messageId : message.id.startsWith(`${revision}:`),
          );
      }
      if (send) {
        yield* threadManagement
          .sendToThread({
            commandId: CommandId.make(`mail:send:${receipt}`),
            messageId,
            projectId,
            threadId,
            text: contextSent && input.prompt ? input.prompt : text,
            attachments: [],
            ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
            mode: "auto",
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(Effect.mapError(chatUnavailable));
      }
      yield* store.transaction(
        Effect.gen(function* () {
          if (threadId !== linkedId) yield* store.setChatThread(thread.id, threadId);
          yield* store.setKv(trackingKey, messageId);
          yield* store.patchThread(thread.id, {
            state: "working",
            stateAt: yield* nowIso,
            workingReason: "drafting",
          });
        }),
      );
      yield* engine.publishThreads([thread.id]);
      return { projectId, threadId, created };
    },
    (effect, input) =>
      sessionLock.withLock(input.threadId, TxReentrantLock.withReadLock(accountLock, effect)),
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

  const retrySave = "The app password update is incomplete. Re-enter it or remove this account.";
  const retryRemove = "Account removal is incomplete. Retry Remove to finish deleting local data.";
  const credentialErrorState = (statusDetail: string) => ({
    credentialPending: true,
    status: "error" as const,
    statusDetail,
  });

  const credentialFailure = (recovery: string) =>
    Effect.fn("MailService.credentialFailure")(function* (
      error: MailCredentials.MailCredentialError,
    ) {
      const message = `${error.message} ${recovery}`;
      yield* store.updateAccount(error.accountId, credentialErrorState(message));
      return yield* new MailError({ code: "unavailable", message });
    });

  // The row records every possible location before a native or filesystem write can start.
  const savePassword = Effect.fn("MailService.savePassword")(
    function* (
      id: MailAccountId,
      password: string,
      preferred: MailCredentials.CredentialStore,
      keychainPossible: boolean,
    ) {
      const credentialStore = yield* credentials.put(id, password, preferred);
      yield* store.updateAccount(id, { credentialStore });
      if (credentialStore === "keychain") yield* credentials.remove(id, "file");
      else if (keychainPossible) yield* credentials.remove(id, "keychain");
      yield* store.updateAccount(id, {
        keychainPossible: credentialStore === "keychain",
        credentialPending: false,
        status: "connecting",
        statusDetail: null,
      });
    },
    Effect.uninterruptible,
    Effect.catchTags({ MailCredentialError: credentialFailure(retrySave) }),
    Effect.tapError(() => engine.publishStatus),
  );

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
      const id = MailAccountId.make(`acct-${yield* uuid}`);
      const preferred = yield* credentials.preferredStore(id);
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
        credentialStore: preferred,
        keychainPossible: preferred === "keychain",
        ...credentialErrorState(retrySave),
        lastSyncAt: null,
        backfillPausedUntil: null,
        createdAt: yield* nowIso,
      });
      yield* savePassword(id, password, preferred, preferred === "keychain");
      yield* readEmailMdText;
      yield* sync.start(id);
      yield* engine.publishStatus;
      return yield* accountView(id);
    },
    changeAccounts,
    sqlSafe,
  );

  const updateAccount: MailService["Service"]["updateAccount"] = Effect.fn(
    "MailService.updateAccount",
  )(
    function* (input) {
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
        const preferred = yield* credentials.preferredStore(account.id);
        const keychainPossible = account.keychainPossible || preferred === "keychain";
        yield* sync.stop(account.id);
        yield* store.updateAccount(account.id, {
          ...credentialErrorState(retrySave),
          keychainPossible,
        });
        yield* savePassword(account.id, password, preferred, keychainPossible);
      }
      if (input.displayName !== undefined && input.displayName.trim()) {
        yield* store.updateAccount(account.id, { displayName: input.displayName.trim() });
      }
      if (input.appPassword !== undefined) yield* sync.start(account.id);
      yield* engine.publishStatus;
      return yield* accountView(account.id);
    },
    changeAccounts,
    sqlSafe,
  );

  const removeAccount: MailService["Service"]["removeAccount"] = Effect.fn(
    "MailService.removeAccount",
  )(
    function* (accountId) {
      const account = yield* store.getAccount(accountId);
      if (account === null) return;
      yield* sync.stop(accountId);
      yield* store.updateAccount(accountId, credentialErrorState(retryRemove));
      yield* Effect.gen(function* () {
        yield* credentials.remove(accountId, "file");
        if (account.keychainPossible) yield* credentials.remove(accountId, "keychain");
      }).pipe(
        Effect.uninterruptible,
        Effect.catchTags({ MailCredentialError: credentialFailure(retryRemove) }),
      );
      const threads = yield* store.sql<{
        id: string;
      }>`SELECT id FROM mail_threads WHERE account_id = ${accountId}`;
      yield* commit(store.deleteAccount(accountId));
      yield* engine.publishRemoved(threads.map((row) => row.id as MailThreadId));
      yield* engine.publishStatus;
    },
    Effect.tapError(() => engine.publishStatus),
    changeAccounts,
    sqlSafe,
  );

  const syncNow: MailService["Service"]["syncNow"] = Effect.fn("MailService.syncNow")(
    function* (accountId) {
      const accounts = yield* store.listAccounts;
      for (const account of accounts) {
        if (accountId !== undefined && account.id !== accountId) continue;
        if (account.credentialPending) {
          if (accountId !== undefined) return yield* invalid(account.statusDetail ?? retrySave);
          continue;
        }
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
    },
    changeAccounts,
    sqlSafe,
  );

  const updateSettings: MailService["Service"]["updateSettings"] = Effect.fn(
    "MailService.updateSettings",
  )(
    function* (input) {
      const current = yield* engine.settings;
      const next: MailSettings = {
        ...current,
        ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
      };
      yield* engine.putSettings(next);
      if (current.syncEnabled !== next.syncEnabled) {
        for (const account of yield* store.listAccounts) {
          if (account.credentialPending) continue;
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
    },
    changeAccounts,
    sqlSafe,
  );

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

  const setTrust: MailService["Service"]["setTrust"] = Effect.fn("MailService.setTrust")(
    function* (input) {
      const kind = input.key.startsWith("category:")
        ? "category"
        : input.key.startsWith("sender:")
          ? "sender"
          : null;
      if (kind === null) return yield* invalid("Unknown trust key.");
      const now = yield* nowIso;
      const records = yield* store.getTrust([input.key]);
      const current = records.get(input.key) ?? emptyRecord(input.key, kind);
      const next = input.trust === "reset" ? null : setLevel(current, input.trust);
      if (next === null) yield* store.deleteTrust(input.key);
      else yield* store.putTrust(next, now);
      yield* store.insertAction({
        at: now,
        actor: "user",
        actorLabel: input.key,
        kind: "trust",
        threadId: null,
        reason: input.trust,
        undo: {
          trust: {
            effect: "level",
            entry: {
              key: input.key,
              kind,
              clock: yield* store.advanceTrustClock(
                input.key,
                input.trust === "reset" ? "reset" : "level",
              ),
            },
            before: previousTrustFields(records.get(input.key) ?? null, next),
          },
        },
      });
    },
    store.transaction,
    sqlSafe,
  );

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
    if ((yield* engine.usage).capped)
      return yield* invalid("The weekly mail token cap has been reached.");
    const prompt = buildVoicePrompt(samples);
    const result = yield* textGeneration
      .generateMailNotes({
        cwd: modelDir,
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
  }).pipe(triageLock.withPermits(1), sqlSafe);

  const dismissRecap: MailService["Service"]["dismissRecap"] = (date) =>
    store.setKv("recap-dismissed", date).pipe(Effect.andThen(engine.publishStatus), sqlSafe);

  yield* fs.makeDirectory(modelDir, { recursive: true }).pipe(Effect.ignore);
  yield* nowIso.pipe(
    Effect.flatMap((now) =>
      store.recoverInterruptedSends(now, `Sending was interrupted. ${MAYBE_SENT}`),
    ),
    Effect.ignore,
  );
  yield* store.requeueWaitingTriage.pipe(Effect.ignore);
  for (const account of yield* store.listAccounts.pipe(Effect.orElseSucceed(() => []))) {
    if (!account.credentialPending) yield* sync.start(account.id);
  }
  yield* triageWorker.pipe(Effect.forkScoped);
  yield* Queue.offer(engine.triageSignal, undefined);
  yield* tick.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);

  return MailService.of({
    arrivals: engine.arrivals,
    subscribe: engine.subscribe.pipe(Stream.mapError(() => storeError())),
    getMessageBody: Effect.fn("MailService.getMessageBody")(sync.getMessageBody, sqlSafe),
    getThread,
    listSettled,
    listThreads,
    search,
    act,
    undo,
    propose,
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
