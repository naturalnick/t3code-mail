import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { MailAccountId, ProviderInstanceId, type MailThreadId } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { ParsedMessage } from "./imapSession.ts";
import * as MailCredentials from "./MailCredentials.ts";
import * as MailEngine from "./MailEngine.ts";
import * as MailService from "./MailService.ts";
import * as MailStore from "./MailStore.ts";
import * as MailSync from "./MailSync.ts";

const accountId = MailAccountId.make("acct-test");
const me = "nick@example.com";
let nextUid = 1;

const message = (input: { subject: string; from?: string; at: string }): ParsedMessage => {
  const uid = nextUid++;
  return {
    uid,
    messageId: `<m${uid}@acme.dev>`,
    gmailThreadId: null,
    labels: null,
    from: { name: "Acme Builds", address: input.from ?? "updates@acme.dev" },
    to: [{ name: "Nick", address: me }],
    cc: [],
    subject: input.subject,
    date: input.at,
    inReplyTo: null,
    references: [],
    seen: false,
    size: 2_000,
    attachments: [],
    textPart: { part: "1", html: false },
    listUnsubscribe: false,
    listId: null,
    precedence: null,
    autoSubmitted: null,
    calendar: false,
  };
};

/** The model settles everything it sees, confidently. */
const textGeneration = Layer.mock(TextGeneration.TextGeneration)({
  generateMailTriage: (input) =>
    Effect.sync(() => ({
      verdicts: [...input.prompt.matchAll(/<email id="(e\d+)">/g)].map((match) => ({
        id: match[1]!,
        summary: "Nightly build passed",
        decision: "settle" as const,
        reason: "fyi",
        category: "notification",
        action: "Settle",
        confidence: 0.92,
        urgent: false,
        injection: false,
      })),
    })),
});

let randomCounter = 0;
const testLayer = (mailDir: string) =>
  MailService.layer.pipe(
    Layer.provideMerge(
      Layer.mock(MailSync.MailSync)({
        start: () => Effect.void,
        stop: () => Effect.void,
        wake: () => Effect.void,
        enqueue: () => Effect.void,
      }),
    ),
    Layer.provideMerge(MailEngine.layer),
    Layer.provideMerge(MailCredentials.layerMemory),
    Layer.provideMerge(MailStore.layerMemory(mailDir)),
    Layer.provide(textGeneration),
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(Layer.mock(ServerSettingsService)({})),
    Layer.provide(
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => new Uint8Array(size).fill(++randomCounter % 256)),
      ),
    ),
  );

const withMail = <A, E>(
  body: Effect.Effect<A, E, MailService.MailService | MailEngine.MailEngine | MailStore.MailStore>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mailDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-mail-" });
    return yield* body.pipe(Effect.provide(testLayer(mailDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Delivers one message the way sync does: ingest, fetch its body, then triage. */
const deliver = (input: { subject: string; body: string; from?: string; at: string }) =>
  Effect.gen(function* () {
    const engine = yield* MailEngine.MailEngine;
    const store = yield* MailStore.MailStore;
    const mail = yield* MailService.MailService;
    const result = yield* engine.ingest(
      {
        accountId,
        accountEmail: me,
        gmail: false,
        mailbox: "INBOX",
        role: "primary",
        initial: false,
        backfill: false,
      },
      [message(input)],
    );
    for (const entry of result.newMessageIds) yield* store.setMessageBody(entry.id, input.body);
    yield* engine.afterBodies(result.threads);
    yield* mail.drainTriage;
    expect(result.threads).toHaveLength(1);
    return result.threads[0]!;
  });

const rowOf = (threadId: MailThreadId) =>
  MailService.MailService.pipe(
    Effect.flatMap((mail) => mail.getThread(threadId)),
    Effect.map((detail) => detail.thread),
  );

describe("MailService trust ramp", () => {
  it.effect("suggests until approved three times, then settles on its own and undo demotes", () =>
    withMail(
      Effect.gen(function* () {
        const mail = yield* MailService.MailService;
        yield* mail.updateSettings({
          defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "luna" },
        });

        for (const night of [1, 2, 3]) {
          const threadId = yield* deliver({
            subject: `Nightly build #${night}`,
            body: `Build ${night} passed in 4m.`,
            at: `2026-11-0${night}T06:00:00.000Z`,
          });
          const row = yield* rowOf(threadId);
          expect(row).toMatchObject({ state: "active", line: "Nightly build passed" });
          expect(row.suggestion).toMatchObject({ reason: "fyi" });
          // A repeated approve (double tap, stale client) is not a second approval.
          for (const _ of [1, 2]) {
            yield* mail.act(
              { threadIds: [threadId], action: { type: "approve" } },
              { actor: "user" },
            );
          }
          expect((yield* rowOf(threadId)).state).toBe("settled");
          if (night === 1) {
            const trust = yield* mail.listTrust;
            expect(
              trust.records.find((record) => record.key === "sender:updates@acme.dev"),
            ).toMatchObject({ approvals: 1, streak: 1 });
          }
        }

        const fourth = yield* deliver({
          subject: "Nightly build #4",
          body: "Build 4 passed in 4m.",
          at: "2026-11-04T06:00:00.000Z",
        });
        expect(yield* rowOf(fourth)).toMatchObject({
          state: "settled",
          settledBy: "ai",
          settledReason: "fyi",
        });

        // Money in the text is a guardrail: a graduated sender still asks first.
        const invoice = yield* deliver({
          subject: "Invoice for build minutes",
          body: "Amount due: $42 by Friday.",
          at: "2026-11-05T06:00:00.000Z",
        });
        expect(yield* rowOf(invoice)).toMatchObject({ state: "active", guardrail: "money" });

        const log = yield* mail.listActions({ actor: "ai" });
        const aiSettle = log.actions.find((action) => action.threadId === fourth);
        expect(aiSettle).toMatchObject({ kind: "settle", undoable: true });
        yield* mail.undo(aiSettle!.id);
        expect((yield* rowOf(fourth)).state).toBe("active");
        const trust = yield* mail.listTrust;
        expect(
          trust.records.find((record) => record.key === "sender:updates@acme.dev"),
        ).toMatchObject({ trust: "suggest", streak: 0 });

        const sixth = yield* deliver({
          subject: "Nightly build #6",
          body: "Build 6 passed in 4m.",
          at: "2026-11-06T06:00:00.000Z",
        });
        expect(yield* rowOf(sixth)).toMatchObject({
          state: "active",
          suggestion: { reason: "fyi" },
        });
      }),
    ),
  );

  it.effect("logs agent drafts and proposals with undo, and never settles for them", () =>
    withMail(
      Effect.gen(function* () {
        const mail = yield* MailService.MailService;
        const agent = { actor: "agent", label: "Inbox helper" } as const;
        const threadId = yield* deliver({
          subject: "Can we move Thursday?",
          from: "sam@example.org",
          body: "Could we do Friday at 10 instead?",
          at: "2026-11-02T09:00:00.000Z",
        });

        yield* mail.propose({ threadIds: [threadId], reason: "done" }, agent);
        expect(yield* rowOf(threadId)).toMatchObject({
          state: "active",
          suggestion: { reason: "done", confidence: 1 },
        });
        yield* mail.saveDraft(
          {
            threadId,
            to: ["sam@example.org"],
            cc: [],
            subject: "Re: Can we move Thursday?",
            body: "Friday works.",
          },
          agent,
        );
        expect((yield* rowOf(threadId)).hasDraft).toBe(true);
        const draft = (yield* mail.getThread(threadId)).drafts[0]!;
        const edited = yield* mail.saveDraft(
          {
            threadId,
            draftId: draft.id,
            to: draft.to,
            cc: draft.cc,
            subject: draft.subject,
            body: "Friday at 10 works.",
          },
          { actor: "user" },
        );
        expect(edited.revision).toBe(draft.revision + 1);
        const priorEdit = {
          threadId,
          draftId: draft.id,
          to: draft.to,
          cc: draft.cc,
          subject: draft.subject,
          body: "Overwrite from an old tab",
          expectedRevision: draft.revision,
        };
        expect((yield* mail.saveDraft(priorEdit, { actor: "user" }).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect((yield* mail.discardDraft(draft.id, draft.revision).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect((yield* mail.getThread(threadId)).drafts[0]?.body).toBe(edited.body);
        // Approval covers one revision; a send of the version the user saw before is refused.
        const stale = yield* mail
          .sendDraft({ draftId: draft.id, revision: draft.revision })
          .pipe(Effect.flip);
        expect(stale.code).toBe("invalid");

        const log = yield* mail.listActions({ actor: "agent" });
        expect(
          log.actions.map((action) => [action.kind, action.actorLabel, action.undoable]),
        ).toEqual([
          ["draft", "Inbox helper", true],
          ["propose", "Inbox helper", true],
        ]);
        for (const action of log.actions) yield* mail.undo(action.id);
        expect(yield* rowOf(threadId)).toMatchObject({ suggestion: null, hasDraft: false });
      }),
    ),
  );
});
