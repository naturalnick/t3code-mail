import type { MailAccountId, MailThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Schedule from "effect/Schedule";
import { MailEngine } from "./MailEngine.ts";
import { MailStore } from "./MailStore.ts";
import { MailSync } from "./MailSync.ts";

export const makeCodeCleanup = Effect.fn("MailCodeCleanup.make")(function* () {
  const engine = yield* MailEngine;
  const store = yield* MailStore;
  const sync = yield* MailSync;
  const worker = yield* FiberHandle.make();
  const sweep = Effect.fn("MailCodeCleanup.sweep")(function* () {
    const now = yield* DateTime.now;
    const ms = DateTime.toEpochMillis(now);
    const { changed, removed } = yield* store.transaction(
      Effect.gen(function* () {
        const changed = new Set<MailThreadId>();
        const settings = yield* engine.settings;
        if (settings.codeCleanupEnabled && settings.syncEnabled) {
          const due = yield* store.sql<{
            id: number;
            threadId: MailThreadId;
            accountId: MailAccountId;
            messageId: string;
            sender: string;
            mailbox: string;
            uid: number;
            uidValidity: string;
          }>`
        SELECT m.id, m.thread_id AS threadId, m.account_id AS accountId, m.message_id AS messageId,
          COALESCE(NULLIF(m.from_name,''), m.from_address) AS sender, m.mailbox, m.uid,
          COALESCE(m.moved_uid_validity,b.uid_validity) AS uidValidity
        FROM mail_messages m JOIN mail_mailboxes b ON b.account_id=m.account_id AND b.path=m.mailbox
        JOIN mail_threads t ON t.id=m.thread_id
        WHERE m.code_received_at IS NOT NULL AND m.code_lifetime IS NOT NULL
          AND m.in_inbox=1 AND m.removed=0 AND m.outgoing=0 AND t.pinned_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM mail_drafts d WHERE d.thread_id=t.id AND d.status IN ('draft','sending','failed'))
          AND (m.code_received_at + ${settings.codeInboxMinutes * 60000} <= ${ms}
            OR m.code_read_at + ${settings.codeReadMinutes * 60000} <= ${ms}
            OR (m.code_lifetime > 0 AND m.code_received_at + m.code_lifetime <= ${ms}))
        ORDER BY m.code_received_at LIMIT 100`;
          for (const row of due) {
            yield* sync.enqueue(row.accountId, {
              kind: "trash",
              locations: [{ mailbox: row.mailbox, uid: row.uid, uidValidity: row.uidValidity }],
            });
            yield* store.insertAction({
              at: DateTime.formatIso(now),
              actor: "mail",
              actorLabel: null,
              kind: "delete",
              reason: "sign_in_code",
              threadId: null,
              undo: {
                trash: { accountId: row.accountId, messageIds: [row.messageId], from: row.sender },
              },
            });
            yield* store.sql`UPDATE mail_messages SET removed=1, in_inbox=0, code_received_at=NULL WHERE id=${row.id}`;
            changed.add(row.threadId);
          }
        }
        const removed = yield* store.deleteExpungedThreads([...changed]);
        for (const id of removed) changed.delete(id);
        for (const id of changed) yield* store.refreshThreadAggregate(id);
        return { changed: [...changed], removed };
      }),
    );
    if (changed.length || removed.length) {
      yield* engine.publishThreads(changed);
      yield* engine.publishRemoved(removed);
      yield* engine.publishStatus;
    }
  });
  return (enabled: boolean) =>
    enabled
      ? FiberHandle.run(
          worker,
          sweep().pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Sign-in code cleanup failed.", { cause }),
            ),
            Effect.repeat(Schedule.spaced("10 seconds")),
          ),
          { onlyIfMissing: true },
        ).pipe(Effect.asVoid)
      : FiberHandle.clear(worker);
});
