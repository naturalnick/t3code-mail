import {
  type MailAccountId,
  MailFormattedBody,
  type MailMessageBodyInput,
  MailThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import type { SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import { beginMacMailActivity } from "./macMailActivity.ts";
import { ImapFailure, ImapSession, classifyImapError, type ParsedMessage } from "./imapSession.ts";
import * as MailCredentials from "./MailCredentials.ts";
import * as MailEngine from "./MailEngine.ts";
import * as MailStore from "./MailStore.ts";
import { type EnqueueOp, enqueueOp, replayOp } from "./mailServerOp.ts";

/** Newest messages fetched on a mailbox's first sync; the rest arrives by backfill. */
const INITIAL_PAGE = 200;
const BACKFILL_PAGE = 150;
const BODY_ROUND = 40;
const DISPLAY_ROUND = 20;
/** One round per sync tick, so a large backfill never holds up new mail. */
const REPLY_TO_ROUND = 200;
/** Recently settled mail is often opened to check what the AI settled. */
const DISPLAY_PREFETCH_DAYS = 14;
const FLAG_WINDOW = 400;
const IDLE_REFRESH_MS = 25 * 60_000;
const BACKFILL_INTERVAL_MS = 20_000;
const SENT_POLL_MS = 5 * 60_000;
const QUOTA_PAUSE_HOURS = 24;
const BODY_ATTEMPTS = 3;
const FETCH_FAILED = Symbol("fetch-failed");
const RECONNECT_DELAYS_MS = [5_000, 15_000, 60_000, 5 * 60_000];

const parseTextPart = (raw: string): { part: string; html: boolean } | null => {
  try {
    return JSON.parse(raw) as { part: string; html: boolean };
  } catch {
    return null;
  }
};
export async function downloadBodies(
  pending: ReadonlyArray<{ id: number; thread_id: string; uid: number; text_part: string }>,
  fetchBody: ImapSession["fetchBody"],
) {
  const bodies: Array<{ id: number; threadId: string; body: string | null | typeof FETCH_FAILED }> =
    [];
  for (const row of pending) {
    const part = row.text_part ? parseTextPart(row.text_part) : null;
    try {
      const body = part === null ? null : await fetchBody(row.uid, part);
      bodies.push({ id: row.id, threadId: row.thread_id, body });
    } catch (error) {
      const failure = classifyImapError(error);
      if (failure.kind === "quota") return { bodies, quota: true };
      if (failure.kind === "auth" || failure.kind === "network") throw failure;
      bodies.push({ id: row.id, threadId: row.thread_id, body: FETCH_FAILED });
    }
  }
  return { bodies, quota: false };
}

interface LiveSession {
  readonly imap: ImapSession;
  readonly wake: () => void;
}

export class MailSync extends Context.Service<
  MailSync,
  {
    /** Starts (or restarts) the account's connection loop. */
    readonly start: (accountId: MailAccountId) => Effect.Effect<void>;
    readonly stop: (accountId: MailAccountId) => Effect.Effect<void>;
    /** Breaks IDLE so queued server ops and a fresh sync run now. */
    readonly wake: (accountId?: MailAccountId) => Effect.Effect<void>;
    readonly enqueue: (accountId: MailAccountId, op: EnqueueOp) => Effect.Effect<void, SqlError>;
    /** Gmail X-GM-RAW search; matches not synced yet are fetched so they show up locally. */
    readonly getMessageBody: (
      input: MailMessageBodyInput,
    ) => Effect.Effect<MailFormattedBody | null, SqlError>;
    /** The message's attachments, for a forward; null when the server cannot be reached. */
    readonly getAttachments: (
      input: MailMessageBodyInput,
      maxBytes: number,
    ) => Effect.Effect<Awaited<ReturnType<ImapSession["fetchAttachments"]>> | null, SqlError>;
    readonly searchGmail: (
      accountId: MailAccountId,
      query: string,
    ) => Effect.Effect<ReadonlyArray<MailThreadId>>;
  }
>()("t3/mail/MailSync") {}

const make = Effect.gen(function* () {
  const store = yield* MailStore.MailStore;
  const engine = yield* MailEngine.MailEngine;
  const credentials = yield* MailCredentials.MailCredentials;
  const platform = yield* HostProcess.Platform;
  const power = yield* HostPowerMonitor.HostPowerMonitor;
  const suspended = yield* SubscriptionRef.make((yield* power.snapshot).suspended);
  let lastTick = yield* Clock.currentTimeMillis;
  yield* power.streamChanges.pipe(
    Stream.runForEach(({ suspended: next }) =>
      Effect.gen(function* () {
        if ((yield* SubscriptionRef.get(suspended)) === next) return;
        lastTick = yield* Clock.currentTimeMillis;
        yield* SubscriptionRef.set(suspended, next);
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  const fibers = yield* FiberMap.make<MailAccountId>();
  const live = new Map<MailAccountId, LiveSession>();

  const nowIso = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(now)));

  const setStatus = (
    accountId: MailAccountId,
    patch: Parameters<MailStore.MailStore["Service"]["updateAccount"]>[1],
  ) =>
    store.updateAccount(accountId, patch).pipe(Effect.andThen(engine.publishStatus), Effect.ignore);

  const promise = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (error) => classifyImapError(error) });

  const syncAccount = Effect.fn("MailSync.syncAccount")(function* (
    accountId: MailAccountId,
    password: string,
  ) {
    const account = yield* store.getAccount(accountId).pipe(Effect.orDie);
    if (account === null) return;
    let dirty = true;
    const expunged = new Map<string, number[]>();
    const imap = new ImapSession(
      {
        host: account.imapHost,
        port: account.imapPort,
        secure: account.imapTls,
        user: account.username,
        password,
      },
      {
        onExists: () => {
          dirty = true;
          void imap.client.noop().catch(() => {});
        },
        onFlags: () => {
          dirty = true;
        },
        onExpunge: (path, uid) => {
          if (uid !== undefined) {
            const pending = expunged.get(path);
            if (pending) pending.push(uid);
            else expunged.set(path, [uid]);
          }
          dirty = true;
        },
        onClose: () => {},
      },
    );
    const scope = yield* Scope.Scope;
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        // A sleeping peer cannot acknowledge LOGOUT. Abort any outstanding IMAP command.
        imap.client.close();
        if (live.get(accountId)?.imap === imap) live.delete(accountId);
      }),
    );
    yield* setStatus(accountId, { status: "connecting", statusDetail: null });
    const roles = yield* promise(() => imap.connect());
    live.set(accountId, {
      imap,
      wake: () => {
        dirty = true;
        if (imap.usable) void imap.client.noop().catch(() => {});
      },
    });
    const baseContext = { accountId, accountEmail: account.email, gmail: roles.gmail };

    const ingest = (
      mailbox: string,
      role: "primary" | "sent",
      messages: ReadonlyArray<ParsedMessage>,
      flags: { initial: boolean; backfill: boolean },
    ) => engine.ingest({ ...baseContext, mailbox, role, ...flags }, messages).pipe(Effect.orDie);

    /** Returns false when UIDVALIDITY changed and the mailbox must start over. */
    const syncMailboxOnce = Effect.fnUntraced(function* (path: string, role: "primary" | "sent") {
      const known = yield* store.getMailbox(accountId, path).pipe(Effect.orDie);
      const localUids =
        known === null || imap.qresync
          ? []
          : yield* store
              .knownUids(accountId, path, Math.max(1, known.maxUid - FLAG_WINDOW))
              .pipe(Effect.orDie);
      const result = yield* promise(() =>
        imap.withMailbox(path, known, async (snapshot) => {
          if (known !== null && known.uidValidity !== snapshot.uidValidity) {
            return { type: "reset" as const };
          }
          if (known === null) {
            const newest = await imap.fetchNewest(snapshot.exists, INITIAL_PAGE);
            // All Mail's newest page can be mostly sent or archived mail; recent inbox mail
            // must not wait for backfill.
            const page = new Set(newest.map((message) => message.uid));
            const inbox = imap.gmail
              ? (await imap.searchGmailRaw("in:inbox"))
                  .filter((uid) => !page.has(uid))
                  .sort((a, b) => a - b)
                  .slice(-INITIAL_PAGE)
              : [];
            return {
              type: "initial" as const,
              snapshot,
              messages: [...(await imap.fetchUids(inbox)), ...newest],
              pageMin: newest[0]?.uid ?? null,
            };
          }
          const newer = await imap.fetchNewer(known.maxUid, 1_000);
          const windowFrom = Math.max(1, known.maxUid - FLAG_WINDOW);
          const unchanged =
            imap.condstore &&
            known.highestModseq !== null &&
            known.highestModseq === snapshot.highestModseq;
          const flagChanges = unchanged
            ? []
            : await imap.fetchFlagChanges({
                sinceModseq: known.highestModseq,
                windowFromUid: windowFrom,
              });
          // QRESYNC reports expunges as events; elsewhere compare the recent window's UIDs.
          const vanished: Array<number> = [];
          if (!imap.qresync && localUids.length > 0) {
            const serverUids = await imap.allUids(windowFrom);
            for (const uid of localUids) if (!serverUids.has(uid)) vanished.push(uid);
          }
          return { type: "incremental" as const, snapshot, messages: newer, flagChanges, vanished };
        }),
      );
      if (result.type === "reset") {
        expunged.delete(path);
        return false;
      }
      // Messages and the UIDVALIDITY that authorizes their queued actions become visible together.
      yield* store
        .transaction(
          Effect.gen(function* () {
            const messages = result.messages;
            yield* ingest(path, role, messages, {
              initial: result.type === "initial",
              backfill: false,
            });
            const maxUid = Math.max(known?.maxUid ?? 0, ...messages.map((message) => message.uid));
            const minUid = result.type === "initial" ? result.pageMin : (known?.minUid ?? null);
            if (result.type === "incremental") {
              yield* engine
                .applyFlags({ accountId, gmail: roles.gmail, mailbox: path }, result.flagChanges)
                .pipe(Effect.orDie);
              yield* engine
                .markRemoved({ accountId, mailbox: path }, result.vanished)
                .pipe(Effect.orDie);
            }
            const removed = expunged.get(path);
            if (removed) {
              expunged.delete(path);
              yield* engine.markRemoved({ accountId, mailbox: path }, removed).pipe(Effect.orDie);
            }
            const backfillDone =
              result.type === "initial"
                ? result.snapshot.exists <= INITIAL_PAGE
                : (known?.backfillDone ?? false);
            if (result.type === "initial" && backfillDone) {
              yield* engine.finishMailboxReset(accountId, path).pipe(Effect.orDie);
            }
            yield* store
              .putMailbox({
                accountId,
                path,
                role,
                uidValidity: result.snapshot.uidValidity,
                maxUid: Math.max(maxUid, 0),
                minUid,
                highestModseq: result.snapshot.highestModseq,
                backfillDone,
              })
              .pipe(Effect.orDie);
          }),
        )
        .pipe(Effect.orDie);
      return true;
    });

    const syncMailbox = Effect.fn("MailSync.syncMailbox")(function* (
      path: string,
      role: "primary" | "sent",
    ) {
      if (yield* syncMailboxOnce(path, role)) return;
      // UIDVALIDITY changed: the cached UIDs mean nothing, so start this mailbox over.
      yield* store.resetMailbox(accountId, path).pipe(Effect.orDie);
      yield* syncMailboxOnce(path, role);
    });

    const bodyPauseKey = `body-quota:${accountId}`;

    const fetchBodies = Effect.fn("MailSync.fetchBodies")(function* (path: string) {
      const now = yield* DateTime.now;
      const bodyPauseUntil = yield* store.getKv(bodyPauseKey).pipe(Effect.orDie);
      if (bodyPauseUntil !== null && bodyPauseUntil > DateTime.formatIso(now)) return 0;
      const pending = yield* store.pendingBodies(accountId, path, BODY_ROUND).pipe(Effect.orDie);
      if (pending.length === 0) return 0;
      const { bodies, quota } = yield* promise(() =>
        imap.withMailbox(path, null, () =>
          downloadBodies(pending, (uid, part) => imap.fetchBody(uid, part)),
        ),
      );
      if (quota) {
        const until = DateTime.formatIso(DateTime.add(now, { hours: QUOTA_PAUSE_HOURS }));
        yield* store.setKv(bodyPauseKey, until).pipe(Effect.orDie);
        yield* setStatus(accountId, { backfillPausedUntil: until });
      }
      for (const entry of bodies) {
        yield* (
          entry.body === FETCH_FAILED
            ? store.bodyFetchFailed(entry.id, BODY_ATTEMPTS)
            : store.setMessageBody(entry.id, entry.body)
        ).pipe(Effect.orDie);
      }
      yield* engine
        .afterBodies([...new Set(bodies.map((entry) => entry.threadId as MailThreadId))])
        .pipe(Effect.orDie);
      return bodies.length;
    });

    const backfill = Effect.fn("MailSync.backfill")(function* (
      path: string,
      role: "primary" | "sent",
    ) {
      const known = yield* store.getMailbox(accountId, path).pipe(Effect.orDie);
      if (known === null || known.backfillDone || known.minUid === null) return;
      const current = yield* store.getAccount(accountId).pipe(Effect.orDie);
      const nowAt = yield* DateTime.now;
      const now = DateTime.formatIso(nowAt);
      if (current?.backfillPausedUntil && current.backfillPausedUntil > now) return;
      const exit = yield* promise(() =>
        imap.withMailbox(path, null, () => imap.fetchOlder(known.minUid!, BACKFILL_PAGE)),
      ).pipe(Effect.exit);
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
        const error = failure && failure._tag === "Fail" ? (failure.error as ImapFailure) : null;
        if (error?.kind === "quota") {
          // Gmail's daily download cap: stop the backfill for a day; new mail keeps flowing.
          yield* setStatus(accountId, {
            backfillPausedUntil: DateTime.formatIso(
              DateTime.add(nowAt, { hours: QUOTA_PAUSE_HOURS }),
            ),
          });
          return;
        }
        return yield* Effect.failCause(exit.cause);
      }
      const messages = exit.value;
      yield* ingest(path, role, messages, { initial: false, backfill: true });
      if (messages.length === 0)
        yield* engine.finishMailboxReset(accountId, path).pipe(Effect.orDie);
      yield* store
        .putMailbox({
          ...known,
          minUid: messages[0]?.uid ?? known.minUid,
          backfillDone: messages.length === 0,
        })
        .pipe(Effect.orDie);
    });

    const runOps = Effect.gen(function* () {
      const ops = yield* store.pendingOps(accountId).pipe(Effect.orDie);
      for (const row of ops) {
        const exit = yield* replayOp(accountId, row.payload, roles, imap).pipe(
          Effect.provideService(MailStore.MailStore, store),
          Effect.exit,
        );
        if (Exit.isSuccess(exit)) yield* store.finishOp(row.id).pipe(Effect.orDie);
        else {
          yield* store.failOp(row.id).pipe(Effect.orDie);
          // A queued inverse must wait for its original operation to finish retrying.
          break;
        }
      }
      yield* store.dropFailedOps.pipe(Effect.orDie);
    });

    // Opening an email paints from the saved formatted body, so fetch it before anyone asks.
    const displayFailed = new Set<number>();
    const fetchDisplayBodies = Effect.fn("MailSync.fetchDisplayBodies")(function* () {
      const since = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, { days: DISPLAY_PREFETCH_DAYS }),
      );
      const bodyPauseUntil = yield* store.getKv(bodyPauseKey).pipe(Effect.orDie);
      if (bodyPauseUntil !== null && bodyPauseUntil > (yield* nowIso)) return 0;
      const pending = yield* store
        .pendingDisplayBodies(accountId, since, [...displayFailed], DISPLAY_ROUND)
        .pipe(Effect.orDie);
      for (const row of pending) {
        const body = yield* loadMessageBody({
          threadId: MailThreadId.make(row.thread_id),
          messageId: row.id,
        }).pipe(Effect.orDie);
        if (body === undefined) displayFailed.add(row.id);
      }
      return pending.length;
    });

    /** Reads Reply-To for mail synced before it was recorded, one round per call. */
    const fetchReplyTo = Effect.fn("MailSync.fetchReplyTo")(function* () {
      const path = roles.primary;
      const known = yield* store.getMailbox(accountId, path).pipe(Effect.orDie);
      if (!known) return;
      const uids = yield* store.pendingReplyTo(accountId, path, REPLY_TO_ROUND).pipe(Effect.orDie);
      if (uids.length === 0) return;
      const found = yield* promise(() =>
        imap.withMailbox(path, null, async (snapshot) =>
          snapshot.uidValidity === known.uidValidity ? imap.fetchReplyTo(uids) : null,
        ),
      );
      if (found === null) return;
      yield* store.setReplyTo(accountId, path, found, uids).pipe(Effect.orDie);
    });

    // First pass: primary, sent, bodies, ops.
    yield* setStatus(accountId, { status: "syncing", statusDetail: null });
    yield* syncMailbox(roles.primary, "primary");
    if (roles.sent !== null) yield* syncMailbox(roles.sent, "sent");
    yield* runOps;
    while ((yield* fetchBodies(roles.primary)) === BODY_ROUND) {}
    if (roles.sent !== null) yield* fetchBodies(roles.sent);
    yield* setStatus(accountId, { status: "idle", lastSyncAt: yield* nowIso });
    while ((yield* fetchDisplayBodies()) === DISPLAY_ROUND) {}

    let lastSent = yield* Clock.currentTimeMillis;
    let lastBackfill = 0;
    while (true) {
      const mailboxes = yield* store.listMailboxes(accountId).pipe(Effect.orDie);
      const backfilling = mailboxes.some((box) => !box.backfillDone);
      if (!dirty) {
        yield* promise(() =>
          imap
            .withMailbox(roles.primary, null, async () => {})
            .then(() =>
              imap.idle(
                backfilling ? BACKFILL_INTERVAL_MS : Math.min(IDLE_REFRESH_MS, SENT_POLL_MS),
              ),
            ),
        );
      }
      dirty = false;
      yield* syncMailbox(roles.primary, "primary");
      const loopAt = yield* Clock.currentTimeMillis;
      if (roles.sent !== null && loopAt - lastSent >= SENT_POLL_MS) {
        lastSent = loopAt;
        yield* syncMailbox(roles.sent, "sent");
      }
      yield* runOps;
      yield* fetchBodies(roles.primary);
      if (roles.sent !== null) yield* fetchBodies(roles.sent);
      yield* fetchDisplayBodies();
      yield* fetchReplyTo();
      if (backfilling && loopAt - lastBackfill >= BACKFILL_INTERVAL_MS) {
        lastBackfill = loopAt;
        yield* backfill(roles.primary, "primary");
        if (roles.sent !== null) yield* backfill(roles.sent, "sent");
      }
      yield* setStatus(accountId, { status: "idle", lastSyncAt: yield* nowIso });
    }
  }, Effect.scoped);

  const runAccount = Effect.fn("MailSync.runAccount")(function* (accountId: MailAccountId) {
    let attempt = 0;
    while (true) {
      const account = yield* store.getAccount(accountId).pipe(Effect.orDie);
      if (account === null) return;
      const settings = yield* engine.settings.pipe(Effect.orDie);
      if (!settings.syncEnabled) {
        yield* setStatus(accountId, { status: "paused", statusDetail: null });
        return;
      }
      const password = yield* credentials
        .get(accountId, account.credentialStore)
        .pipe(Effect.orElseSucceed(() => null));
      if (password === null) {
        yield* setStatus(accountId, {
          status: "auth_failed",
          statusDetail: "No app password is saved for this account.",
        });
        return;
      }
      if (attempt === 0 && platform === "darwin") {
        yield* Effect.acquireRelease(
          Effect.try({
            try: beginMacMailActivity,
            catch: () => "Could not disable App Nap for mail sync",
          }),
          (end) => Effect.sync(end),
        ).pipe(Effect.catch((warning) => Effect.logWarning(warning)));
      }
      const exit = yield* syncAccount(accountId, password).pipe(Effect.exit);
      if (Exit.isSuccess(exit)) return;
      const failure = exit.cause.reasons.find(
        (reason) => reason._tag === "Fail" || reason._tag === "Die",
      );
      const error = classifyImapError(
        failure?._tag === "Fail"
          ? failure.error
          : failure?._tag === "Die"
            ? failure.defect
            : undefined,
      );
      if (error.kind === "auth") {
        // Revoked app passwords must be visible, never a silent stop.
        yield* setStatus(accountId, { status: "auth_failed", statusDetail: error.detail });
        return;
      }
      yield* setStatus(accountId, {
        status: error.kind === "network" ? "offline" : "error",
        statusDetail: error.detail,
      });
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
      attempt += 1;
      yield* Effect.sleep(Duration.millis(delay));
    }
  }, Effect.scoped);

  const start: MailSync["Service"]["start"] = (accountId) =>
    FiberMap.run(
      fibers,
      accountId,
      SubscriptionRef.changes(suspended).pipe(
        Stream.switchMap((asleep) =>
          asleep
            ? Stream.fromEffect(setStatus(accountId, { status: "paused" })).pipe(Stream.drain)
            : Stream.fromEffect(runAccount(accountId)),
        ),
        // A completed account loop (disabled or invalid credentials) stays stopped through wake.
        Stream.runHead,
        Effect.asVoid,
      ),
    ).pipe(Effect.asVoid);

  const stop: MailSync["Service"]["stop"] = (accountId) => FiberMap.remove(fibers, accountId);

  const wake: MailSync["Service"]["wake"] = (accountId) =>
    Effect.sync(() => {
      for (const [id, session] of live)
        if (accountId === undefined || id === accountId) session.wake();
    });

  const enqueue: MailSync["Service"]["enqueue"] = (accountId, op) =>
    nowIso.pipe(
      Effect.flatMap((now) => enqueueOp(accountId, op, now)),
      Effect.provideService(MailStore.MailStore, store),
      Effect.andThen(wake(accountId)),
    );

  const displayLock = yield* KeyedLock.make<number>();
  const displayBodyJson = Schema.fromJsonString(Schema.NullOr(MailFormattedBody));
  /** Undefined when the body could not be read right now, so a later call tries again. */
  const loadMessageBody = Effect.fn("MailSync.loadMessageBody")(
    function* ({ threadId, messageId }: MailMessageBodyInput) {
      const cached = yield* store.sql<{
        content: string;
      }>`SELECT d.content FROM mail_display_bodies d
        JOIN mail_messages m ON m.id = d.id WHERE m.id = ${messageId} AND m.thread_id = ${threadId} AND m.removed = 0`;
      if (cached[0])
        return yield* Schema.decodeEffect(displayBodyJson)(cached[0].content).pipe(Effect.orDie);
      const [target] = yield* store.messageTargets(threadId, [messageId]);
      if (!target) return undefined;
      const imap = live.get(target.accountId)?.imap;
      if (!imap) return undefined;
      const pause = yield* store.getKv(`body-quota:${target.accountId}`);
      if (pause && pause > (yield* nowIso)) return undefined;
      const result = yield* promise(() =>
        imap.withMailbox(target.mailbox, null, async (box) =>
          box.uidValidity === target.uidValidity
            ? { body: await imap.fetchFormattedBody(target.uid) }
            : null,
        ),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (error.kind === "quota") {
              const until = DateTime.formatIso(
                DateTime.add(yield* DateTime.now, { hours: QUOTA_PAUSE_HOURS }),
              );
              yield* store.setKv(`body-quota:${target.accountId}`, until);
              yield* setStatus(target.accountId, { backfillPausedUntil: until });
            }
            return null;
          }),
        ),
      );
      if (!result) return undefined;
      return yield* store.transaction(
        Effect.gen(function* () {
          const [current] = yield* store.messageTargets(threadId, [messageId]);
          if (current?.identity !== target.identity) return undefined;
          const content = yield* Schema.encodeEffect(displayBodyJson)(result.body).pipe(
            Effect.orDie,
          );
          yield* store.sql`INSERT OR REPLACE INTO mail_display_bodies(id,content) VALUES (${messageId},${content})`;
          return result.body;
        }),
      );
    },
    (operation, input) => displayLock.withLock(input.messageId, operation),
  );
  const getMessageBody: MailSync["Service"]["getMessageBody"] = (input) =>
    loadMessageBody(input).pipe(Effect.map((body) => body ?? null));
  const getAttachments: MailSync["Service"]["getAttachments"] = Effect.fn(
    "MailSync.getAttachments",
  )(function* (input, maxBytes) {
    const [target] = yield* store.messageTargets(input.threadId, [input.messageId]);
    const imap = target ? live.get(target.accountId)?.imap : undefined;
    if (!target || !imap) return null;
    return yield* promise(() =>
      imap.withMailbox(target.mailbox, null, async (box) =>
        box.uidValidity === target.uidValidity ? imap.fetchAttachments(target.uid, maxBytes) : null,
      ),
    ).pipe(Effect.orElseSucceed(() => null));
  });
  const searchGmail: MailSync["Service"]["searchGmail"] = Effect.fn("MailSync.searchGmail")(
    function* (accountId, query) {
      const session = live.get(accountId);
      const account = yield* store.getAccount(accountId).pipe(Effect.orDie);
      if (!session?.imap.roles?.gmail || account === null) return [];
      const primary = session.imap.roles.primary;
      const known = yield* store.getMailbox(accountId, primary).pipe(Effect.orDie);
      if (!known) return [];
      const found = yield* promise(() =>
        session.imap.withMailbox(primary, null, async (snapshot) =>
          snapshot.uidValidity === known.uidValidity
            ? (await session.imap.searchGmailRaw(query)).slice(-200)
            : [],
        ),
      );
      if (!found.length) return [];
      const cached = yield* store.knownUidsAmong(accountId, primary, found).pipe(Effect.orDie);
      const missing = found.filter((uid) => !cached.has(uid)).slice(-50);
      const messages =
        missing.length === 0
          ? []
          : yield* promise(() =>
              session.imap.withMailbox(primary, null, async (snapshot) =>
                snapshot.uidValidity === known.uidValidity ? session.imap.fetchUids(missing) : [],
              ),
            );
      return yield* store
        .transaction(
          Effect.gen(function* () {
            const current = yield* store.getMailbox(accountId, primary);
            if (current?.uidValidity !== known.uidValidity) return [];
            if (messages.length > 0) {
              yield* engine.ingest(
                {
                  accountId,
                  accountEmail: account.email,
                  gmail: true,
                  mailbox: primary,
                  role: "primary",
                  initial: false,
                  backfill: true,
                },
                messages,
              );
              session.wake();
            }
            const threads = yield* store.sql<{
              thread_id: string;
            }>`SELECT DISTINCT thread_id FROM mail_messages
          WHERE account_id = ${accountId} AND mailbox = ${primary} AND removed = 0 AND uid IN ${store.sql.in(found)}`;
            return threads.map((row) => MailThreadId.make(row.thread_id));
          }),
        )
        .pipe(Effect.orDie);
    },
    Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<MailThreadId>)),
  );

  // A long gap between ticks means the machine slept: reconnect now instead of waiting for TCP to notice.
  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const slept = now - lastTick > 90_000;
    lastTick = now;
    if (!slept || (yield* SubscriptionRef.get(suspended))) return;
    yield* SubscriptionRef.set(suspended, false);
  }).pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);

  return MailSync.of({ start, stop, wake, enqueue, getMessageBody, getAttachments, searchGmail });
});

export const layer = Layer.effect(MailSync, make);
