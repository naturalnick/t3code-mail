import { type MailAccountId, MailThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { classifyImapError, type ImapSession, type MailboxRoles } from "./imapSession.ts";
import * as MailStore from "./MailStore.ts";

const targets = Schema.Array(MailStore.MessageTarget);
const ServerOp = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["archive", "unarchive"]),
    threadId: MailThreadId,
    targets,
  }),
  Schema.Struct({
    kind: Schema.Literal("seen"),
    threadId: MailThreadId,
    seen: Schema.Boolean,
    targets,
  }),
  Schema.Struct({ kind: Schema.Literal("append_sent"), raw: Schema.String }),
]);
type ServerOp = typeof ServerOp.Type;
export type EnqueueOp =
  | ServerOp
  | {
      readonly kind: "seen";
      readonly threadId: MailThreadId;
      readonly seen: boolean;
      readonly messageIds?: ReadonlyArray<number>;
    };

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ServerOp));

export const enqueueOp = Effect.fn("MailSync.enqueueOp")(function* (
  accountId: MailAccountId,
  input: EnqueueOp,
  now: string,
) {
  const store = yield* MailStore.MailStore;
  let op: ServerOp;
  if (input.kind === "seen" && !("targets" in input)) {
    const rows = yield* store.messageTargets(input.threadId, input.messageIds);
    op = {
      kind: input.kind,
      threadId: input.threadId,
      seen: input.seen,
      targets: rows.map(({ id, identity }) => ({ id, identity })),
    };
  } else {
    op = input;
  }
  if (op.kind === "append_sent" || op.targets.length > 0)
    yield* store.enqueueOp(accountId, op.kind, op, now);
});

type MirrorSession = Pick<
  ImapSession,
  "withMailbox" | "append" | "setSeen" | "setInboxLabel" | "ensureMailbox" | "move"
>;

export const replayOp = Effect.fn("MailSync.runOp")(function* (
  accountId: MailAccountId,
  raw: string,
  roles: MailboxRoles,
  imap: MirrorSession,
) {
  const op = Option.getOrNull(decode(raw));
  // Legacy thread-wide operations have no record of which messages the user acted on.
  if (op === null) return;
  const request = <A>(tryImap: () => Promise<A>) =>
    Effect.tryPromise({ try: tryImap, catch: classifyImapError });
  if (op.kind === "append_sent") {
    const sent = roles.sent;
    if (sent !== null) yield* request(() => imap.append(sent, Buffer.from(op.raw, "base64")));
    return;
  }
  const store = yield* MailStore.MailStore;
  const identities = new Map(op.targets.map((target) => [target.id, target.identity]));
  const rows = yield* store.messageTargets(op.threadId, [...identities.keys()]);
  const located = rows.filter(
    (row) => row.accountId === accountId && identities.get(row.id) === row.identity,
  );
  const toInbox = op.kind === "unarchive";
  const archive = roles.archive ?? "Archive";
  for (const [path, candidates] of Map.groupBy(located, (row) => row.mailbox)) {
    if (op.kind !== "seen" && path !== (roles.gmail || !toInbox ? roles.primary : archive))
      continue;
    const updates = yield* request(() =>
      imap.withMailbox(path, null, async (snapshot) => {
        const matching = candidates.filter((row) => row.uidValidity === snapshot.uidValidity);
        if (matching.length === 0) return [];
        const uids = matching.map((row) => row.uid);
        if (op.kind === "seen") {
          await imap.setSeen(uids, op.seen);
          return [];
        }
        if (roles.gmail) {
          await imap.setInboxLabel(uids, toInbox);
          return matching.map((row) => ({ from: row, to: row }));
        }
        const destination = toInbox ? roles.primary : archive;
        if (!toInbox && roles.archive === null) await imap.ensureMailbox(archive);
        const moved = await imap.move(uids, destination);
        if (!moved) return [];
        return matching.flatMap((row) => {
          const uid = moved.uidMap.get(row.uid);
          return uid === undefined
            ? []
            : [{ from: row, to: { mailbox: destination, uid, uidValidity: moved.uidValidity } }];
        });
      }),
    );
    if (updates.length > 0) {
      yield* store.transaction(
        Effect.gen(function* () {
          for (const { from, to } of updates)
            yield* store.moveMessage(accountId, from, to, toInbox);
          yield* store.refreshThreadAggregate(op.threadId);
        }),
      );
    }
  }
});
