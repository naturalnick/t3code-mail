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
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as SqlError from "effect/sql/SqlError";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest keeps thread ids a pure function of the root message.
import * as NodeCrypto from "node:crypto";

import type { ParsedMessage } from "./imapSession.ts";
import { firstLine, stripQuoted } from "./mailText.ts";
import * as MailStore from "./MailStore.ts";

const DEFAULT_SETTINGS: MailSettings = {
  defaultModelSelection: null,
  escalationModelSelection: null,
  trustThreshold: 3,
  weeklyTokenCap: 300_000,
  serverMirroring: false,
  recapEnabled: true,
  notificationsEnabled: true,
  nudgeReplyDays: 3,
  nudgeWaitingDays: 5,
  syncEnabled: true,
  rules: [],
};

const SETTLED_IN_SNAPSHOT = 60;
/** Backfilled mail older than this lands settled without a model call. */

const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(MailSettingsSchema));

export interface IngestContext {
  readonly accountId: MailAccountId;
  readonly accountEmail: string;
  readonly gmail: boolean;
  readonly mailbox: string;
  readonly role: "primary" | "sent";
  /** The first page of a fresh mailbox: old mail is the backlog, not news. */
  readonly initial: boolean;
  readonly backfill: boolean;
}

export interface IngestResult {
  readonly newMessageIds: ReadonlyArray<{ readonly id: number; readonly uid: number }>;
  readonly threads: ReadonlyArray<MailThreadId>;
}

const QUESTION = /\?\s*$/m;

function hashKey(value: string): string {
  return NodeCrypto.createHash("sha1").update(value).digest("hex").slice(0, 20);
}

const startOfWeekIso = (now: DateTime.DateTime) =>
  DateTime.formatIso(DateTime.startOf(now, "week", { weekStartsOn: 1 }));

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
    readonly status: Effect.Effect<MailStatus, SqlError.SqlError>;
    readonly rows: (
      ids: ReadonlyArray<MailThreadId>,
    ) => Effect.Effect<ReadonlyArray<MailThreadRow>, SqlError.SqlError>;
    readonly subscribe: Stream.Stream<MailStreamEvent, SqlError.SqlError>;
    readonly settings: Effect.Effect<MailSettings, SqlError.SqlError>;
    readonly putSettings: (settings: MailSettings) => Effect.Effect<void, SqlError.SqlError>;
    readonly usage: Effect.Effect<MailUsage, SqlError.SqlError>;
    readonly recap: Effect.Effect<MailRecap | null, SqlError.SqlError>;
    /** Wakes the L1 worker after threads were queued for triage. */
    readonly triageSignal: Queue.Queue<void>;
    readonly providerTokens: (tokens: number | null) => Effect.Effect<void>;
  }
>()("t3/mail/MailEngine") {}

const make = Effect.gen(function* () {
  const store = yield* MailStore.MailStore;
  const hub = yield* PubSub.unbounded<MailStreamEvent>();
  const triageSignal = yield* Queue.sliding<void>(1);
  let providerTokensThisWeek: number | null = null;

  const localNow = DateTime.now.pipe(
    Effect.map((now) => DateTime.setZone(now, DateTime.zoneMakeLocal())),
  );
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const settings = store.getKv("settings").pipe(
    Effect.map((raw) => {
      if (raw === null) return DEFAULT_SETTINGS;
      const decoded = decodeSettings(raw);
      return decoded._tag === "Some" ? { ...DEFAULT_SETTINGS, ...decoded.value } : DEFAULT_SETTINGS;
    }),
  );
  const putSettings = (next: MailSettings) => store.setKv("settings", JSON.stringify(next));

  const usage = Effect.gen(function* () {
    const weekStart = startOfWeekIso(yield* localNow);
    const used = yield* store.usageSince(weekStart);
    const current = yield* settings;
    return {
      weekStart,
      tokens: used.tokens,
      calls: used.calls,
      emails: used.emails,
      cap: current.weeklyTokenCap,
      capped: current.weeklyTokenCap !== null && used.tokens >= current.weeklyTokenCap,
      providerTokens: providerTokensThisWeek,
    } satisfies MailUsage;
  });

  const recap = Effect.gen(function* () {
    const current = yield* settings;
    if (!current.recapEnabled) return null;
    const now = yield* localNow;
    const date = localDateKey(now);
    if ((yield* store.getKv("recap-dismissed")) === date) return null;
    const since = DateTime.formatIso(DateTime.subtract(now, { days: 1 }));
    const actions = yield* store.actionsSince(since);
    const settles = actions.filter((action) => action.kind === "settle");
    const byAi = settles.filter((action) => action.actor === "ai" || action.actor === "rule");
    if (actions.length === 0 && (yield* store.threadsCreatedSince(since)) === 0) return null;
    const aiThreads = yield* store.getThreads(
      byAi.flatMap((action) => (action.threadId === null ? [] : [action.threadId])),
    );
    const senderCounts = new Map<string, number>();
    for (const thread of aiThreads) {
      const name = thread.fromName || thread.fromAddress;
      senderCounts.set(name, (senderCounts.get(name) ?? 0) + 1);
    }
    const active = yield* store.threadsByState("active");
    return {
      date,
      arrived: yield* store.threadsCreatedSince(since),
      settledByAi: byAi.length,
      settledByYou: settles.length - byAi.length,
      needsYou: active.length,
      topAiSenders: [...senderCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name]) => name),
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
      settings: yield* settings,
      usage: yield* usage,
      recap: yield* recap,
      sessionProjectId: MAIL_SESSION_PROJECT_ID,
      emailMdPath: `${store.workspaceDir}/EMAIL.md`,
      settledCount: yield* store.countSettled,
    } satisfies MailStatus;
  });

  const rows = Effect.fn("MailEngine.rows")(function* (ids: ReadonlyArray<MailThreadId>) {
    const threads = yield* store.getThreads(ids);
    const drafts = yield* store.threadsWithDrafts(threads.map((thread) => thread.id));
    return threads.map((thread) => MailStore.threadRow(thread, drafts.has(thread.id)));
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

  const snapshot = Effect.gen(function* () {
    const threads = yield* store.openThreads(SETTLED_IN_SNAPSHOT);
    const drafts = yield* store.threadsWithDrafts(threads.map((thread) => thread.id));
    return {
      type: "snapshot" as const,
      status: yield* status,
      threads: threads.map((thread) => MailStore.threadRow(thread, drafts.has(thread.id))),
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
    if (context.gmail && message.gmailThreadId) {
      return MailThreadId.make(`${context.accountId}:g:${message.gmailThreadId}`);
    }
    const related = [message.inReplyTo, ...message.references].filter(
      (value): value is string => value !== null,
    );
    const existing = yield* store.findThreadIdByMessageIds(context.accountId, related);
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
    const now = yield* nowIso;
    const me = context.accountEmail.toLowerCase();
    const newMessageIds: Array<{ id: number; uid: number }> = [];
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
        to: message.to,
        cc: message.cc,
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
      if (message.textPart !== null) newMessageIds.push({ id: result.id, uid: message.uid });
      const entry = touched.get(threadId)!;
      (outgoing ? entry.outgoing : entry.incoming).push(message);
    }

    const changed: Array<MailThreadId> = [];
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
        // Mail the user already dealt with elsewhere, or old backfilled mail, arrives settled.
        const arrivesSettled = context.backfill || (!inInbox && !lastIsMine);
        yield* store.insertThread({
          id,
          accountId: context.accountId,
          subject: newest.subject,
          fromName: newest.from.name,
          fromAddress: newest.from.address,
          line: newest.subject,
          suggestedAction: null,
          lastMessageAt: newest.date,
          lastIncomingAt: null,
          lastOutgoingAt: null,
          messageCount: 0,
          incomingCount: 0,
          unread: false,
          inInbox,
          state: arrivesSettled || lastIsMine ? "settled" : "active",
          stateAt: context.initial || context.backfill ? newest.date : now,
          pinnedAt: null,
          workingReason: null,
          settledReason: arrivesSettled ? "archived" : lastIsMine ? "replied" : null,
          settledBy: arrivesSettled || lastIsMine ? "mail" : null,
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
      } else if (!context.backfill) {
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
            settledBy: "user",
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
    yield* publishThreads(changed);
    if (queuedTriage) yield* Queue.offer(triageSignal, undefined);
    return { newMessageIds, threads: changed };
  });

  const applyFlags: MailEngine["Service"]["applyFlags"] = Effect.fn("MailEngine.applyFlags")(
    function* (context, changes) {
      const now = yield* nowIso;
      const touched = new Map<string, boolean | null>();
      for (const change of changes) {
        const inInbox =
          context.gmail && change.labels !== null ? change.labels.includes("\\Inbox") : undefined;
        const threadId = yield* store.updateFlags(context.accountId, context.mailbox, change.uid, {
          seen: change.seen,
          ...(change.labels === null ? {} : { labels: change.labels }),
          ...(inInbox === undefined ? {} : { inInbox }),
        });
        if (threadId !== null && !touched.has(threadId)) {
          touched.set(threadId, (yield* store.getThread(threadId))?.inInbox ?? null);
        }
      }
      const changed: Array<MailThreadId> = [];
      for (const [rawId, inInboxBefore] of touched) {
        const id = MailThreadId.make(rawId);
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
        if (thread.triageState === "pending" && thread.line === thread.subject) {
          // A readable line until L1 writes the summary.
          yield* store.setTriage(id, {
            triageState: "pending",
            line: firstLine(latest.body) || thread.subject,
          });
        }
        if (
          latest.outgoing &&
          thread.state === "settled" &&
          thread.settledReason === "replied" &&
          QUESTION.test(stripQuoted(latest.body))
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

  const markRemoved: MailEngine["Service"]["markRemoved"] = Effect.fn("MailEngine.markRemoved")(
    function* (context, uids) {
      const threads = yield* store.markRemoved(context.accountId, context.mailbox, uids);
      for (const id of threads) yield* store.refreshThreadAggregate(id);
      yield* publishThreads(threads);
    },
  );

  return MailEngine.of({
    ingest,
    applyFlags,
    markRemoved,
    afterBodies,
    publishThreads,
    publishRemoved,
    publishStatus,
    status,
    rows,
    subscribe,
    settings,
    putSettings,
    usage,
    recap,
    triageSignal,
    providerTokens: Effect.fn("MailEngine.providerTokens")((tokens) =>
      Effect.sync(() => {
        providerTokensThisWeek = tokens;
      }),
    ),
  });
});

export const layer = Layer.effect(MailEngine, make);
