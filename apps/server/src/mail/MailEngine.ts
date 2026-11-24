import {
  type MailAccountId,
  type MailRecap,
  type MailSettings,
  type MailStatus,
  type MailStreamEvent,
  type MailThreadRow,
  type MailUsage,
  MailSettings as MailSettingsSchema,
  MailThreadId,
  MAIL_SESSION_PROJECT_ID,
  ModelSelection,
  ThreadId,
  UsageDay,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest keeps thread ids a pure function of the root message.
import * as NodeCrypto from "node:crypto";

import type { ParsedMessage } from "./imapSession.ts";
import { asksQuestion, stripQuoted } from "./mailText.ts";
import { ensureMailUsageIndex } from "./mailUsageIndex.ts";
import * as MailStore from "./MailStore.ts";

/** The recap lists this many settled emails and counts the rest. */
const RECAP_ITEMS = 25;

const SETTLED_IN_SNAPSHOT = 60;
/** Backfilled mail older than this lands settled without a model call. */

const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(MailSettingsSchema));
const decodeModelSelection = Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection));

export interface IngestContext {
  readonly accountId: MailAccountId;
  readonly accountEmail: string;
  readonly gmail: boolean;
  readonly mailbox: string;
  readonly role: "primary" | "sent" | "folder";
  /** The first page of a fresh mailbox: old mail is the backlog, not news. */
  readonly initial: boolean;
  readonly backfill: boolean;
}

export interface IngestResult {
  readonly newMessageIds: ReadonlyArray<{ readonly id: number; readonly uid: number }>;
  readonly threads: ReadonlyArray<MailThreadId>;
}

/** Backfilled inbox mail older than this is history; it arrives settled. */
const BACKLOG_DAYS = 30;

function hashKey(value: string): string {
  return NodeCrypto.createHash("sha1").update(value).digest("hex").slice(0, 20);
}

function localDateKey(now: DateTime.DateTime): string {
  const parts = DateTime.toParts(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export class MailEngine extends Context.Service<
  MailEngine,
  {
    readonly ingest: (
      context: IngestContext,
      messages: ReadonlyArray<ParsedMessage>,
    ) => Effect.Effect<IngestResult, SqlError.SqlError>;
    /** Applies server-side flag or label changes; a Gmail archive elsewhere settles the thread. */
    readonly applyFlags: (
      context: Pick<IngestContext, "accountId" | "gmail" | "mailbox">,
      changes: ReadonlyArray<{
        readonly uid: number;
        readonly seen: boolean;
        readonly labels: ReadonlyArray<string> | null;
      }>,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly finishMailboxReset: (
      accountId: MailAccountId,
      mailbox: string,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly markRemoved: (
      context: Pick<IngestContext, "accountId" | "mailbox">,
      uids: ReadonlyArray<number>,
    ) => Effect.Effect<void, SqlError.SqlError>;
    /** Runs once bodies arrive: a readable line, and "waiting on reply" when the user asked something. */
    readonly afterBodies: (
      ids: ReadonlyArray<MailThreadId>,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly publishThreads: (
      ids: ReadonlyArray<MailThreadId>,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly publishRemoved: (ids: ReadonlyArray<MailThreadId>) => Effect.Effect<void>;
    readonly publishStatus: Effect.Effect<void, SqlError.SqlError>;
    readonly refreshChatUsage: Effect.Effect<void, SqlError.SqlError>;
    /** The model of the coding thread the user most recently ran, for a new Mail home chat. */
    readonly lastCodingModel: Effect.Effect<ModelSelection | null, SqlError.SqlError>;
    readonly status: Effect.Effect<MailStatus, SqlError.SqlError>;
    readonly rows: (
      ids: ReadonlyArray<MailThreadId>,
    ) => Effect.Effect<ReadonlyArray<MailThreadRow>, SqlError.SqlError>;
    readonly arrivals: Stream.Stream<{ readonly count: number }>;
    readonly subscribe: Stream.Stream<MailStreamEvent, SqlError.SqlError>;
    readonly settings: Effect.Effect<MailSettings, SqlError.SqlError>;
    readonly putSettings: (settings: MailSettings) => Effect.Effect<void, SqlError.SqlError>;
    readonly usage: Effect.Effect<MailUsage, SqlError.SqlError>;
    readonly recap: Effect.Effect<MailRecap | null, SqlError.SqlError>;
    /** Wakes the L1 worker after threads were queued for triage. */
    readonly triageSignal: Queue.Queue<void>;
  }
>()("t3/mail/MailEngine") {}

const make = Effect.gen(function* () {
  const store = yield* MailStore.MailStore;
  const hub = yield* PubSub.unbounded<MailStreamEvent>();
  const arrivals = yield* PubSub.sliding<{ readonly count: number }>(1);
  const triageSignal = yield* Queue.sliding<void>(1);
  const orchestration = yield* SqlClient.SqlClient;
  yield* ensureMailUsageIndex;

  const localNow = DateTime.now.pipe(
    Effect.map((now) => DateTime.setZone(now, DateTime.zoneMakeLocal())),
  );
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const settings = store.getKv("settings").pipe(
    Effect.map((raw) => {
      if (raw === null) return MailStore.DEFAULT_SETTINGS;
      const decoded = decodeSettings(raw);
      return decoded._tag === "Some"
        ? { ...MailStore.DEFAULT_SETTINGS, ...decoded.value }
        : MailStore.DEFAULT_SETTINGS;
    }),
  );
  const putSettings = (next: MailSettings) => store.setKv("settings", JSON.stringify(next));

  const usage = Effect.gen(function* () {
    const now = yield* localNow;
    const monday = DateTime.startOf(now, "week", { weekStartsOn: 1 });
    const weekStart = DateTime.formatIso(monday);
    const estimated = yield* store.usageSince(weekStart);
    // The projection has one row per provider turn. Its input/output already include cache and reasoning.
    const [chat] = yield* orchestration<{ tokens: number; calls: number }>`
      SELECT COALESCE(SUM(
        COALESCE(json_extract(t.payload_json, '$.turnTokenUsage.inputTokens'), 0)
        + COALESCE(json_extract(t.payload_json, '$.turnTokenUsage.outputTokens'), 0)
      ), 0) AS tokens, COUNT(*) AS calls
      FROM orchestration_v2_projection_threads AS thread
      JOIN orchestration_v2_projection_provider_turns AS t ON t.thread_id = thread.thread_id
      WHERE thread.project_id = ${MAIL_SESSION_PROJECT_ID} AND t.completed_at >= ${weekStart}
        AND t.completed_at <= ${DateTime.formatIso(now)}
        AND json_extract(t.payload_json, '$.turnTokenUsage.usageStatus') IN ('complete', 'partial')
        AND COALESCE(json_extract(t.payload_json, '$.turnTokenUsage.localCommand'), 0) = 0
        AND (json_extract(t.payload_json, '$.turnTokenUsage.inputTokens') IS NOT NULL
          OR json_extract(t.payload_json, '$.turnTokenUsage.outputTokens') IS NOT NULL)
    `.pipe(NodeSqliteClient.readOnly);
    const tokens = estimated.tokens + (chat?.tokens ?? 0);
    const current = yield* settings;
    return {
      weekStart,
      providerWindow: {
        sinceDay: UsageDay.make(DateTime.formatIsoDate(monday)),
        untilDay: UsageDay.make(DateTime.formatIsoDate(now)),
        timeZone: DateTime.zoneToString(now.zone),
      },
      tokens,
      estimatedTokens: estimated.tokens,
      calls: estimated.calls + (chat?.calls ?? 0),
      emails: estimated.emails,
      cap: current.weeklyTokenCap,
      capped: current.weeklyTokenCap !== null && tokens >= current.weeklyTokenCap,
      providerTokens: null,
    } satisfies MailUsage;
  });

  const recap = Effect.gen(function* () {
    const current = yield* settings;
    if (!current.recapEnabled) return null;
    const now = yield* localNow;
    const date = localDateKey(now);
    if ((yield* store.getKv("recap-dismissed")) === date) return null;
    const since = DateTime.formatIso(DateTime.subtract(now, { days: 1 }));
    const day = yield* store.recapSince(since, RECAP_ITEMS);
    if (day.actions === 0 && day.arrived === 0) return null;
    return {
      date,
      arrived: day.arrived,
      needsYou: day.needsYou,
      settledByAi: day.settledByAi,
      settledByYou: day.settledByYou,
      topAiSenders: day.topAiSenders,
      // Only what is still settled: anything back in Active is already in front of the user.
      settled: day.settled.map(({ actionId, actor, thread }) => ({
        actionId,
        threadId: thread.id,
        from: thread.fromName || thread.fromAddress,
        subject: thread.subject,
        reason: thread.settledReason ?? "fyi",
        actor,
        // A rule with a condition was checked by the model, which says why it applied.
        why: actor === "ai" || actor === "rule" ? (thread.verdict?.why ?? null) : null,
        decidedBy: actor === "ai" || actor === "rule" ? (thread.verdict?.by ?? null) : null,
      })),
      moreSettled: Math.max(0, day.total - day.settled.length),
    } satisfies MailRecap;
  });

  const status = Effect.gen(function* () {
    const accounts = yield* store.listAccounts;
    const withCounts = yield* Effect.forEach(accounts, (account) =>
      Effect.gen(function* () {
        const mailboxes = yield* store.listMailboxes(account.id);
        return {
          id: account.id,
          email: account.email,
          labels: account.labels ?? [],
          folders: account.folders ?? [],
          displayName: account.displayName,
          provider: account.provider,
          imapHost: account.imapHost,
          imapPort: account.imapPort,
          smtpHost: account.smtpHost,
          smtpPort: account.smtpPort,
          status: account.status,
          statusDetail: account.statusDetail,
          lastSyncAt: account.lastSyncAt,
          messageCount: yield* store.accountMessageCount(account.id),
          backfillDone: mailboxes.length > 0 && mailboxes.every((box) => box.backfillDone),
          backfillPausedUntil: account.backfillPausedUntil,
          credentialStore: account.credentialStore,
        };
      }),
    );
    return {
      accounts: withCounts,
      capabilities: { spam: true, draftAttachments: true, bcc: true },
      settings: yield* settings,
      usage: yield* usage,
      recap: yield* recap,
      sessionProjectId: MAIL_SESSION_PROJECT_ID,
      emailMdPath: `${store.workspaceDir}/EMAIL.md`,
      settledCount: yield* store.countSettled,
      ...(yield* store.reviewCounts),
      hubChatThreadId: yield* store
        .getKv(MailStore.HUB_CHAT_KEY)
        .pipe(Effect.map((id) => (id === null ? null : ThreadId.make(id)))),
    } satisfies MailStatus;
  });

  const rows = Effect.fn("MailEngine.rows")(function* (ids: ReadonlyArray<MailThreadId>) {
    const threads = yield* store.getThreads(ids);
    return yield* store.rowsWithDrafts(threads);
  });

  const publishThreads = (ids: ReadonlyArray<MailThreadId>) =>
    ids.length === 0
      ? Effect.void
      : rows(ids).pipe(
          Effect.flatMap((upserted) =>
            PubSub.publish(hub, { type: "threads", upserted, removed: [] }),
          ),
          Effect.asVoid,
        );
  const publishRemoved = (ids: ReadonlyArray<MailThreadId>) =>
    ids.length === 0
      ? Effect.void
      : PubSub.publish(hub, { type: "threads", upserted: [], removed: ids }).pipe(Effect.asVoid);
  const publishStatus = status.pipe(
    Effect.flatMap((next) => PubSub.publish(hub, { type: "status", status: next })),
    Effect.asVoid,
  );

  let lastUsageCheck: { day: string; updatedAt: string | null } | undefined;
  const refreshChatUsage = Effect.gen(function* () {
    const day = DateTime.formatIsoDate(yield* localNow);
    // Every provider turn touches its thread. The project/updated_at index also covers empty weeks.
    const [thread] = yield* orchestration<{ updated_at: string }>`
      SELECT updated_at FROM orchestration_v2_projection_threads
      WHERE project_id = ${MAIL_SESSION_PROJECT_ID} ORDER BY updated_at DESC LIMIT 1
    `.pipe(NodeSqliteClient.readOnly);
    const updatedAt = thread?.updated_at ?? null;
    if (lastUsageCheck && (lastUsageCheck.day !== day || lastUsageCheck.updatedAt !== updatedAt)) {
      yield* publishStatus;
    }
    lastUsageCheck = { day, updatedAt };
  });

  const lastCodingModel = Effect.gen(function* () {
    // Every provider turn touches its thread, so the newest user-started coding thread ran last.
    const [thread] = yield* orchestration<{ selection: string | null }>`
      SELECT json_extract(payload_json, '$.modelSelection') AS selection
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND archived_at IS NULL
        AND project_id != ${MAIL_SESSION_PROJECT_ID}
        AND json_extract(payload_json, '$.createdBy') = 'user'
        AND json_extract(payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
      ORDER BY updated_at DESC LIMIT 1
    `.pipe(NodeSqliteClient.readOnly);
    return thread?.selection ? Option.getOrNull(decodeModelSelection(thread.selection)) : null;
  });

  const snapshot = Effect.gen(function* () {
    const threads = yield* store.openThreads(SETTLED_IN_SNAPSHOT);
    return {
      type: "snapshot" as const,
      status: yield* status,
      threads: yield* store.rowsWithDrafts(threads),
    };
  });

  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before the snapshot read so changes in between are not lost.
      const subscription = yield* PubSub.subscribe(hub);
      return Stream.concat(Stream.fromEffect(snapshot), Stream.fromSubscription(subscription));
    }),
  );

  // Per ingested message, inside ingest's span.
  const resolveThreadId = Effect.fnUntraced(function* (
    context: IngestContext,
    message: ParsedMessage,
  ) {
    const related = [message.inReplyTo, ...message.references].filter(
      (value): value is string => value !== null,
    );
    // A new email written here keeps its own thread: the server's copy of it and replies join it.
    const composed = yield* store.findComposedThread(
      context.accountId,
      message.messageId === null ? related : [message.messageId, ...related],
    );
    if (composed !== null) return composed;
    if (context.gmail && message.gmailThreadId) {
      return MailThreadId.make(`${context.accountId}:g:${message.gmailThreadId}`);
    }
    const existing = yield* store.findThreadIdByMessageIds(
      context.accountId,
      related,
      message.messageId,
    );
    if (existing !== null) return existing;
    const root = message.references[0] ?? message.inReplyTo ?? message.messageId;
    return MailThreadId.make(
      `${context.accountId}:m:${hashKey(root ?? `${context.mailbox}:${message.uid}:${message.subject}`)}`,
    );
  });

  const ingest = Effect.fn("MailEngine.ingest")(function* (
    context: IngestContext,
    messages: ReadonlyArray<ParsedMessage>,
  ) {
    const nowAt = yield* DateTime.now;
    const now = DateTime.formatIso(nowAt);
    const backlogCutoff = DateTime.formatIso(DateTime.subtract(nowAt, { days: BACKLOG_DAYS }));
    const result = yield* store.transaction(
      ingestInTransaction(context, messages, now, backlogCutoff),
    );
    yield* publishThreads(result.visible);
    if (
      result.arrived > 0 &&
      !context.initial &&
      !context.backfill &&
      (yield* settings).notificationsEnabled
    ) {
      yield* PubSub.publish(arrivals, { count: result.arrived });
    }
    if (result.quiet) yield* publishStatus;
    if (result.queuedTriage) yield* Queue.offer(triageSignal, undefined);
    return { newMessageIds: result.newMessageIds, threads: result.changed };
  });

  // Inside ingest's span and transaction.
  const ingestInTransaction = Effect.fnUntraced(function* (
    context: IngestContext,
    messages: ReadonlyArray<ParsedMessage>,
    now: string,
    backlogCutoff: string,
  ) {
    const me = context.accountEmail.toLowerCase();
    const newMessageIds: Array<{ id: number; uid: number }> = [];
    let arrived = 0;
    const cleanupSince = yield* store.getKv("code-cleanup-since");
    const touched = new Map<
      string,
      {
        incoming: Array<ParsedMessage>;
        outgoing: Array<ParsedMessage>;
        inInboxBefore: boolean | null;
      }
    >();
    for (const message of messages) {
      const labels = message.labels;
      const outgoing = context.gmail
        ? (labels?.includes("\\Sent") ?? false) || message.from.address === me
        : context.role === "sent" || message.from.address === me;
      const inInbox = context.gmail
        ? (labels?.includes("\\Inbox") ?? false)
        : context.role === "primary";
      const threadId = yield* resolveThreadId(context, message);
      if (!touched.has(threadId)) {
        const before = yield* store.getThread(threadId);
        touched.set(threadId, {
          incoming: [],
          outgoing: [],
          inInboxBefore: before?.inInbox ?? null,
        });
      }
      const result = yield* store.upsertMessage({
        accountId: context.accountId,
        mailbox: context.mailbox,
        uid: message.uid,
        messageId: message.messageId,
        threadId,
        labels,
        inInbox,
        from: message.from,
        replyTo: message.replyTo,
        to: message.to,
        cc: message.cc,
        bcc: outgoing ? message.bcc : undefined,
        subject: message.subject,
        date: message.date,
        inReplyTo: message.inReplyTo,
        references: message.references,
        seen: message.seen || outgoing,
        outgoing,
        size: message.size,
        attachments: message.attachments,
        listUnsubscribe: message.listUnsubscribe,
        listId: message.listId,
        precedence: message.precedence,
        autoSubmitted: message.autoSubmitted,
        calendar: message.calendar,
        textPart: message.textPart,
      });
      if (!result.inserted) continue;
      const received = message.deliveredAt;
      if (
        cleanupSince &&
        received !== undefined &&
        received >= Number(cleanupSince) &&
        !outgoing &&
        inInbox &&
        message.messageId &&
        !message.calendar &&
        !message.listId &&
        !message.listUnsubscribe &&
        !message.attachments.some((file) => !file.contentType.startsWith("image/"))
      ) {
        yield* store.sql`UPDATE mail_messages SET code_received_at = ${Math.min(received, Date.parse(now))},
          code_read_at = ${message.seen ? Date.parse(now) : null} WHERE id = ${result.id}
          AND NOT EXISTS (SELECT 1 FROM mail_actions WHERE reason = 'sign_in_code'
            AND json_extract(undo_json, '$.trash.accountId') = ${context.accountId}
            AND json_extract(undo_json, '$.trash.messageIds[0]') = ${message.messageId})`;
        if (message.textPart === null) yield* store.setMessageBody(result.id, null);
      }
      if (!outgoing && inInbox && !message.seen) arrived++;
      if (message.textPart !== null) newMessageIds.push({ id: result.id, uid: message.uid });
      const entry = touched.get(threadId)!;
      (outgoing ? entry.outgoing : entry.incoming).push(message);
    }

    const changed: Array<MailThreadId> = [];
    // Backfilled history that lands settled is counted, not streamed row by row.
    const visible: Array<MailThreadId> = [];
    let quiet = false;
    let queuedTriage = false;
    for (const [rawId, entry] of touched) {
      const id = MailThreadId.make(rawId);
      if (entry.incoming.length === 0 && entry.outgoing.length === 0) continue;
      const existing = yield* store.getThread(id);
      const newest = [...entry.incoming, ...entry.outgoing]
        .sort((a, b) => a.date.localeCompare(b.date))
        .at(-1)!;
      if (existing === null) {
        const lastIsMine = entry.outgoing.length > 0 && newest === entry.outgoing.at(-1);
        const inInbox = context.gmail
          ? [...entry.incoming, ...entry.outgoing].some((message) =>
              message.labels?.includes("\\Inbox"),
            )
          : context.role === "primary";
        // Mail already dealt with elsewhere arrives settled, and so does old backfilled history.
        // Recent inbox mail that backfill reaches is triaged like new mail.
        const arrivesSettled =
          (!inInbox && !lastIsMine) || (context.backfill && inInbox && newest.date < backlogCutoff);
        const historical = context.initial || context.backfill;
        const settledReason = arrivesSettled ? "archived" : lastIsMine ? "replied" : null;
        yield* store.insertThread({
          id,
          accountId: context.accountId,
          subject: newest.subject,
          fromName: newest.from.name,
          fromAddress: newest.from.address,
          suggestedAction: null,
          lastMessageAt: newest.date,
          lastIncomingAt: null,
          lastOutgoingAt: null,
          messageCount: 0,
          incomingCount: 0,
          unread: false,
          inInbox,
          state: settledReason === null ? "active" : "settled",
          stateAt: historical ? newest.date : now,
          pinnedAt: null,
          workingReason: null,
          settledReason,
          settledBy:
            settledReason === null
              ? null
              : settledReason === "replied" && !historical
                ? "user"
                : "mail",
          snoozedUntil: null,
          snoozeOnReply: false,
          suggestionReason: null,
          suggestionConfidence: null,
          category: null,
          guardrail: null,
          bulk: false,
          verdict: null,
          triageState: arrivesSettled || lastIsMine ? "done" : "pending",
          triagedCount: 0,
          nudge: null,
          chatThreadId: null,
          injection: false,
          createdAt: now,
        });
        if (!arrivesSettled && !lastIsMine) queuedTriage = true;
        if (context.backfill && (arrivesSettled || lastIsMine)) quiet = true;
        else visible.push(id);
      } else if (!context.backfill && (!context.initial || newest.date > existing.lastMessageAt)) {
        // A first sync (or a UIDVALIDITY re-sync) only acts on mail newer than the thread knew.
        visible.push(id);
        const latestIsIncoming = entry.incoming.length > 0 && newest === entry.incoming.at(-1);
        if (latestIsIncoming) {
          // A reply from someone else brings the thread back, wherever it was.
          const returns =
            existing.state === "settled" ||
            (existing.state === "snoozed" && existing.snoozeOnReply) ||
            existing.state === "working";
          yield* store.patchThread(id, {
            ...(returns
              ? {
                  state: "active",
                  stateAt: now,
                  settledReason: null,
                  settledBy: null,
                  snoozedUntil: null,
                  snoozeOnReply: false,
                  workingReason: null,
                }
              : {}),
            suggestionReason: null,
            suggestionConfidence: null,
            nudge: null,
          });
          yield* store.setTriage(id, { triageState: "pending" });
          queuedTriage = true;
          if (returns && existing.state !== "working") {
            yield* store.insertAction({
              at: now,
              actor: "mail",
              actorLabel: null,
              kind: "returned",
              threadId: id,
              reason: "reply",
              undo: null,
            });
          }
        } else if (existing.state === "active" || existing.state === "snoozed") {
          // Waiting-on-reply is decided in afterBodies, once the reply's text is here.
          yield* store.patchThread(id, {
            state: "settled",
            stateAt: now,
            workingReason: null,
            settledReason: "replied",
            settledBy: context.initial ? "mail" : "user",
            snoozedUntil: null,
            snoozeOnReply: false,
            suggestionReason: null,
            suggestionConfidence: null,
            nudge: null,
          });
        }
      }
      yield* store.refreshThreadAggregate(id);
      changed.push(id);
    }
    return { newMessageIds, changed, visible, quiet, queuedTriage, arrived };
  });

  const applyFlags: MailEngine["Service"]["applyFlags"] = Effect.fn("MailEngine.applyFlags")(
    function* (context, changes) {
      const now = yield* nowIso;
      const touched = yield* store.updateFlags(
        context.accountId,
        context.mailbox,
        changes.map((change) => ({
          ...change,
          ...(context.gmail && change.labels !== null
            ? { inInbox: change.labels.includes("\\Inbox") }
            : {}),
        })),
      );
      const changed: Array<MailThreadId> = [];
      for (const id of touched) {
        const inInboxBefore = context.gmail ? (yield* store.getThread(id))?.inInbox : undefined;
        const thread = yield* store.refreshThreadAggregate(id);
        if (thread === null) continue;
        if (
          context.gmail &&
          inInboxBefore === true &&
          !thread.inInbox &&
          thread.state !== "settled" &&
          thread.pinnedAt === null
        ) {
          // Archived in Gmail itself: the user handled it there.
          yield* store.patchThread(id, {
            state: "settled",
            stateAt: now,
            settledReason: "archived",
            settledBy: "mail",
            suggestionReason: null,
            suggestionConfidence: null,
            workingReason: null,
            snoozedUntil: null,
            snoozeOnReply: false,
          });
        } else if (
          context.gmail &&
          inInboxBefore === false &&
          thread.inInbox &&
          thread.state === "settled"
        ) {
          yield* store.patchThread(id, {
            state: "active",
            stateAt: now,
            settledReason: null,
            settledBy: null,
          });
        }
        changed.push(id);
      }
      yield* publishThreads(changed);
    },
  );

  const afterBodies: MailEngine["Service"]["afterBodies"] = Effect.fn("MailEngine.afterBodies")(
    function* (ids) {
      const now = yield* nowIso;
      for (const id of ids) {
        const thread = yield* store.getThread(id);
        const latest = yield* store.latestMessage(id);
        if (thread === null || latest === null || latest.body === null) continue;
        if (
          latest.outgoing &&
          thread.state === "settled" &&
          thread.settledReason === "replied" &&
          thread.settledBy === "user" &&
          asksQuestion(stripQuoted(latest.body))
        ) {
          yield* store.patchThread(id, {
            state: "working",
            stateAt: now,
            workingReason: "waiting",
            settledReason: null,
            settledBy: null,
          });
        }
      }
      yield* publishThreads(ids);
      // Triage waits for bodies; this is when they arrive.
      yield* Queue.offer(triageSignal, undefined);
    },
  );

  const finishMailboxReset: MailEngine["Service"]["finishMailboxReset"] = Effect.fn(
    "MailEngine.finishMailboxReset",
  )(function* (accountId, mailbox) {
    yield* publishRemoved(yield* store.finishMailboxReset(accountId, mailbox));
  });

  const markRemoved: MailEngine["Service"]["markRemoved"] = Effect.fn("MailEngine.markRemoved")(
    function* (context, uids) {
      if (uids.length === 0) return;
      const { changed, removed } = yield* store.transaction(
        Effect.gen(function* () {
          const affected = yield* store.markRemoved(context.accountId, context.mailbox, uids);
          const removed = yield* store.deleteExpungedThreads(affected);
          const removedSet = new Set(removed);
          const changed = affected.filter((id) => !removedSet.has(id));
          for (const id of changed) yield* store.refreshThreadAggregate(id);
          return { changed, removed };
        }),
      );
      yield* publishThreads(changed);
      yield* publishRemoved(removed);
    },
  );

  return MailEngine.of({
    lastCodingModel,
    ingest,
    applyFlags,
    markRemoved,
    finishMailboxReset,
    afterBodies,
    publishThreads,
    publishRemoved,
    publishStatus,
    refreshChatUsage,
    status,
    rows,
    arrivals: Stream.fromPubSub(arrivals),
    subscribe,
    settings,
    putSettings,
    usage,
    recap,
    triageSignal,
  });
});

export const layer = Layer.effect(MailEngine, make);
