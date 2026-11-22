import { type MailAccountId, type MailThreadId } from "@t3tools/contracts";
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

import { ImapFailure, ImapSession, classifyImapError, type ParsedMessage } from "./imapSession.ts";
import * as MailCredentials from "./MailCredentials.ts";
import * as MailEngine from "./MailEngine.ts";
import * as MailStore from "./MailStore.ts";

/** Newest messages fetched on a mailbox's first sync; the rest arrives by backfill. */
const INITIAL_PAGE = 200;
const BACKFILL_PAGE = 150;
const BODY_ROUND = 40;
const FLAG_WINDOW = 400;
const IDLE_REFRESH_MS = 25 * 60_000;
const BACKFILL_INTERVAL_MS = 20_000;
const SENT_POLL_MS = 5 * 60_000;
const QUOTA_PAUSE_HOURS = 24;
const BODY_ATTEMPTS = 3;
const FETCH_FAILED = Symbol("fetch-failed");
const RECONNECT_DELAYS_MS = [5_000, 15_000, 60_000, 5 * 60_000];

export type ServerOp =
  | { readonly kind: "archive"; readonly threadId: MailThreadId }
  | { readonly kind: "unarchive"; readonly threadId: MailThreadId }
  | { readonly kind: "seen"; readonly threadId: MailThreadId; readonly seen: boolean }
  | { readonly kind: "append_sent"; readonly raw: string };

const parseTextPart = (raw: string): { part: string; html: boolean } | null => {
  try {
    return JSON.parse(raw) as { part: string; html: boolean };
  } catch {
    return null;
  }
};
const parseOp = (raw: string): ServerOp | null => {
  try {
    return JSON.parse(raw) as ServerOp;
  } catch {
    return null;
  }
};

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
    readonly enqueue: (accountId: MailAccountId, op: ServerOp) => Effect.Effect<void>;
    /** Gmail X-GM-RAW search; matches not synced yet are fetched so they show up locally. */
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
    const expunged: Array<{ path: string; uid: number }> = [];
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
          if (uid !== undefined) expunged.push({ path, uid });
          dirty = true;
        },
        onClose: () => {},
      },
    );
    const scope = yield* Scope.Scope;
    yield* Scope.addFinalizer(
      scope,
      Effect.promise(() => imap.close()).pipe(
        Effect.andThen(Effect.sync(() => live.delete(accountId))),
      ),
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
        known === null
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
          const unchanged = imap.condstore && known.highestModseq === snapshot.highestModseq;
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
      if (result.type === "reset") return false;
      const messages = result.messages;
      yield* ingest(path, role, messages, { initial: result.type === "initial", backfill: false });
      const maxUid = Math.max(known?.maxUid ?? 0, ...messages.map((message) => message.uid));
      const minUid = result.type === "initial" ? result.pageMin : (known?.minUid ?? null);
      if (result.type === "incremental") {
        yield* engine
          .applyFlags({ accountId, gmail: roles.gmail, mailbox: path }, result.flagChanges)
          .pipe(Effect.orDie);
        yield* engine.markRemoved({ accountId, mailbox: path }, result.vanished).pipe(Effect.orDie);
      }
      const removed = expunged
        .splice(0)
        .filter((entry) => entry.path === path)
        .map((entry) => entry.uid);
      if (removed.length > 0) {
        yield* engine.markRemoved({ accountId, mailbox: path }, removed).pipe(Effect.orDie);
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
          backfillDone:
            result.type === "initial"
              ? result.snapshot.exists <= INITIAL_PAGE
              : (known?.backfillDone ?? false),
        })
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

    const fetchBodies = Effect.fn("MailSync.fetchBodies")(function* (path: string) {
      const pending = yield* store.pendingBodies(accountId, path, BODY_ROUND).pipe(Effect.orDie);
      if (pending.length === 0) return 0;
      const bodies = yield* promise(() =>
        imap.withMailbox(path, null, async () => {
          const results: Array<{
            id: number;
            threadId: string;
            body: string | null | typeof FETCH_FAILED;
          }> = [];
          for (const row of pending) {
            const part = row.text_part ? parseTextPart(row.text_part) : null;
            const body =
              part === null
                ? null
                : await imap
                    .fetchBody(row.uid, part)
                    .catch((): typeof FETCH_FAILED => FETCH_FAILED);
            results.push({ id: row.id, threadId: row.thread_id, body });
          }
          return results;
        }),
      );
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
      yield* store
        .putMailbox({
          ...known,
          minUid: messages[0]?.uid ?? known.minUid,
          backfillDone: messages.length === 0,
        })
        .pipe(Effect.orDie);
      // After a UIDVALIDITY reset, threads whose mail never came back are gone for good.
      if (messages.length === 0) yield* engine.removeEmptyThreads(accountId).pipe(Effect.orDie);
    });

    const runOps = Effect.gen(function* () {
      const ops = yield* store.pendingOps(accountId).pipe(Effect.orDie);
      for (const row of ops) {
        const op = parseOp(row.payload);
        const exit = op === null ? Exit.void : yield* runOp(op).pipe(Effect.exit);
        if (Exit.isSuccess(exit)) yield* store.finishOp(row.id).pipe(Effect.orDie);
        else yield* store.failOp(row.id).pipe(Effect.orDie);
      }
      yield* store.dropFailedOps.pipe(Effect.orDie);
    });

    const runOp = Effect.fn("MailSync.runOp")(function* (op: ServerOp) {
      if (op.kind === "append_sent") {
        if (roles.sent !== null) {
          const sent = roles.sent;
          yield* promise(() => imap.append(sent, Buffer.from(op.raw, "base64")));
        }
        return;
      }
      const located = yield* store.messageUidsForThread(op.threadId).pipe(Effect.orDie);
      if (op.kind === "seen") {
        for (const path of new Set(located.map((row) => row.mailbox))) {
          const uids = located.filter((row) => row.mailbox === path).map((row) => row.uid);
          yield* promise(() => imap.withMailbox(path, null, () => imap.setSeen(uids, op.seen)));
        }
        return;
      }
      const toInbox = op.kind === "unarchive";
      if (roles.gmail) {
        const uids = located.filter((row) => row.mailbox === roles.primary).map((row) => row.uid);
        yield* promise(() =>
          imap.withMailbox(roles.primary, null, () => imap.setInboxLabel(uids, toInbox)),
        );
        for (const row of located) {
          yield* store.moveMessage(row.id, row.mailbox, row.uid, toInbox).pipe(Effect.orDie);
        }
        return;
      }
      const archive = roles.archive ?? "Archive";
      if (roles.archive === null) yield* promise(() => imap.ensureMailbox(archive));
      const from = toInbox ? archive : roles.primary;
      const to = toInbox ? roles.primary : archive;
      const rows = located.filter((row) => row.mailbox === from);
      if (rows.length === 0) return;
      const moved = yield* promise(() =>
        imap.withMailbox(from, null, () =>
          imap.move(
            rows.map((row) => row.uid),
            to,
          ),
        ),
      );
      for (const row of rows) {
        const newUid = moved.get(row.uid);
        // Without UIDPLUS the next sync of the destination finds it again.
        if (newUid !== undefined) {
          yield* store.moveMessage(row.id, to, newUid, toInbox).pipe(Effect.orDie);
        }
      }
    });

    // First pass: primary, sent, bodies, ops.
    yield* setStatus(accountId, { status: "syncing", statusDetail: null });
    yield* syncMailbox(roles.primary, "primary");
    if (roles.sent !== null) yield* syncMailbox(roles.sent, "sent");
    yield* runOps;
    while ((yield* fetchBodies(roles.primary)) === BODY_ROUND) {}
    if (roles.sent !== null) yield* fetchBodies(roles.sent);
    yield* setStatus(accountId, { status: "idle", lastSyncAt: yield* nowIso });

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
  });

  const start: MailSync["Service"]["start"] = (accountId) =>
    FiberMap.run(fibers, accountId, runAccount(accountId)).pipe(Effect.asVoid);

  const stop: MailSync["Service"]["stop"] = (accountId) => FiberMap.remove(fibers, accountId);

  const wake: MailSync["Service"]["wake"] = (accountId) =>
    Effect.sync(() => {
      for (const [id, session] of live)
        if (accountId === undefined || id === accountId) session.wake();
    });

  const enqueue: MailSync["Service"]["enqueue"] = (accountId, op) =>
    nowIso.pipe(
      Effect.flatMap((now) => store.enqueueOp(accountId, op.kind, op, now)),
      Effect.andThen(wake(accountId)),
      Effect.ignore,
    );

  const searchGmail: MailSync["Service"]["searchGmail"] = Effect.fn("MailSync.searchGmail")(
    function* (accountId, query) {
      const session = live.get(accountId);
      const account = yield* store.getAccount(accountId).pipe(Effect.orDie);
      if (!session?.imap.roles?.gmail || account === null) return [];
      const primary = session.imap.roles.primary;
      const known = new Set(yield* store.knownUids(accountId, primary, 1).pipe(Effect.orDie));
      const fetched = yield* promise(() =>
        session.imap.withMailbox(primary, null, async () => {
          const uids = (await session.imap.searchGmailRaw(query)).slice(-200);
          const missing = uids.filter((uid) => !known.has(uid)).slice(-50);
          return { uids, messages: await session.imap.fetchUids(missing) };
        }),
      ).pipe(
        Effect.orElseSucceed(() => ({
          uids: [] as ReadonlyArray<number>,
          messages: [] as ReadonlyArray<ParsedMessage>,
        })),
      );
      if (fetched.messages.length > 0) {
        yield* engine
          .ingest(
            {
              accountId,
              accountEmail: account.email,
              gmail: true,
              mailbox: primary,
              role: "primary",
              initial: false,
              backfill: true,
            },
            fetched.messages,
          )
          .pipe(Effect.orDie);
        session.wake();
      }
      const threads = yield* store.sql<{
        thread_id: string;
      }>`SELECT DISTINCT thread_id FROM mail_messages
        WHERE account_id = ${accountId} AND mailbox = ${primary} AND uid IN ${store.sql.in(fetched.uids)}`.pipe(
        Effect.orElseSucceed(() => []),
      );
      return threads.map((row) => row.thread_id as MailThreadId);
    },
    Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<MailThreadId>)),
  );

  // A long gap between ticks means the machine slept: reconnect now instead of waiting for TCP to notice.
  let lastTick = yield* Clock.currentTimeMillis;
  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const slept = now - lastTick > 90_000;
    lastTick = now;
    if (!slept) return;
    for (const accountId of live.keys()) yield* start(accountId);
  }).pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);

  return MailSync.of({ start, stop, wake, enqueue, searchGmail });
});

export const layer = Layer.effect(MailSync, make);
