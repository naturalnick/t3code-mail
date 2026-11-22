import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { MailAccountId, ProviderInstanceId, ThreadId, type MailThreadId } from "@t3tools/contracts";
import type { MailTriageVerdict } from "@t3tools/provider-core/server/textGeneration";
import * as SqlClient from "effect/sql/SqlClient";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { describe, expect, vi } from "vite-plus/test";

import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ImapSession from "./imapSession.ts";
import type { ParsedMessage } from "./imapSession.ts";
import { enqueueOp, replayOp } from "./mailServerOp.ts";
import * as MailCredentials from "./MailCredentials.ts";
import * as MailEngine from "./MailEngine.ts";
import * as MailService from "./MailService.ts";
import * as MailStore from "./MailStore.ts";
import * as MailSync from "./MailSync.ts";
import * as Smtp from "./smtpSend.ts";

vi.mock(import("./smtpSend.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  sendRaw: async (_config, message) => ({ accepted: [...message.to, ...message.cc], rejected: [] }),
}));

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "luna" };
const at = "2026-11-02T09:00:00.000Z";
const accountId = MailAccountId.make("acct-test");
const me = "nick@example.com";
let nextUid = 1;

interface MessageInput {
  subject: string;
  from?: string;
  at: string;
  listUnsubscribe?: boolean;
}

const message = (input: MessageInput): ParsedMessage => {
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
    listUnsubscribe: input.listUnsubscribe ?? false,
    listId: null,
    precedence: null,
    autoSubmitted: null,
    calendar: false,
  };
};

type ModelReply = (model: string) => Partial<MailTriageVerdict>;

const textGeneration = (reply: ModelReply) =>
  Layer.mock(TextGeneration.TextGeneration)({
    generateMailNotes: () => Effect.succeed({ notes: "Voice notes" }),
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
          ...reply(input.modelSelection.model),
        })),
      })),
  });

let randomCounter = 0;
const testLayer = (
  mailDir: string,
  reply: ModelReply,
  onPrompt?: (prompt: string) => void,
  credentials = MailCredentials.layerMemory,
) =>
  MailService.layer.pipe(
    Layer.provideMerge(
      Layer.unwrap(
        Effect.map(MailStore.MailStore, (store) =>
          Layer.mock(MailSync.MailSync)({
            start: () => Effect.void,
            stop: () => Effect.void,
            wake: () => Effect.void,
            enqueue: (id, op) =>
              enqueueOp(id, op, at).pipe(Effect.provideService(MailStore.MailStore, store)),
          }),
        ),
      ),
    ),
    Layer.provideMerge(MailEngine.layer),
    Layer.provideMerge(credentials),
    Layer.provideMerge(MailStore.layerMemory(mailDir)),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(textGeneration(reply)),
    Layer.provide(
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Effect.sync(() => {
            onPrompt?.(input.initialMessage?.text ?? "");
            const threadId = input.threadId ?? ThreadId.make(input.commandId);
            return {
              threadId,
              projection: idleThreadProjection(liveThreadShell(threadId)),
              resumed: false,
            };
          }),
      }),
    ),
    Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeedSome({
            id,
            title: "Mail",
            workspaceRoot: mailDir,
            scripts: [],
            defaultModelSelection: null,
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
          }),
      }),
    ),
    Layer.provide(Layer.mock(ServerSettingsService)({})),
    Layer.provide(
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => new Uint8Array(size).fill(++randomCounter % 256)),
      ),
    ),
  );

const withMail = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | SqlClient.SqlClient
    | MailService.MailService
    | MailEngine.MailEngine
    | MailStore.MailStore
    | MailCredentials.MailCredentials
  >,
  onPrompt?: (prompt: string) => void,
  reply: ModelReply = () => ({}),
  credentials = MailCredentials.layerMemory,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mailDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-mail-" });
    return yield* body.pipe(Effect.provide(testLayer(mailDir, reply, onPrompt, credentials)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Delivers one message the way sync does: ingest, fetch its body, then triage. */
const deliver = (input: MessageInput & { body: string; account?: MailAccountId }) =>
  Effect.gen(function* () {
    const engine = yield* MailEngine.MailEngine;
    const store = yield* MailStore.MailStore;
    const mail = yield* MailService.MailService;
    const result = yield* engine.ingest(
      {
        accountId: input.account ?? accountId,
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
              {
                threadIds: [threadId],
                action: {
                  type: "approve",
                  revisions: {
                    [threadId]: (yield* rowOf(threadId)).suggestion?.revision ?? "already-settled",
                  },
                },
              },
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

        const engine = yield* MailEngine.MailEngine;
        const callsBefore = (yield* engine.usage).calls;
        for (const entry of [
          {
            subject: "Build configuration",
            body: "Can you choose a target?",
            listUnsubscribe: false,
          },
          { subject: "New digest", body: "This is our first digest.", listUnsubscribe: true },
        ]) {
          yield* deliver({ ...entry, at: "2026-11-04T08:00:00.000Z" });
        }
        expect((yield* engine.usage).calls).toBe(callsBefore + 2);

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

  it.effect.each([
    { category: "invoice", guardrail: "money", subject: "Statement enclosed", list: false },
    { category: "security", guardrail: "security", subject: "Urgent sale update", list: true },
    { category: "legal", guardrail: "legal", subject: "Urgent bulletin", list: true },
  ])("applies the model's $category guardrail before trust", (entry) =>
    withMail(
      Effect.gen(function* () {
        const mail = yield* MailService.MailService;
        yield* mail.updateSettings({
          defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "luna" },
        });
        yield* mail.setTrust({ key: `category:${entry.category}`, trust: "auto" });
        const threadId = yield* deliver({
          subject: entry.subject,
          body: "Please read the enclosed document.",
          listUnsubscribe: entry.list,
          at: "2026-11-01T06:00:00.000Z",
        });
        expect(yield* rowOf(threadId)).toMatchObject({
          state: "active",
          guardrail: entry.guardrail,
          suggestion: { reason: "fyi" },
        });
      }),
      undefined,
      () => ({ category: entry.category }),
    ),
  );

  it.effect("keeps an uncertain settle as a suggestion after escalation", () =>
    withMail(
      Effect.gen(function* () {
        const mail = yield* MailService.MailService;
        const instanceId = ProviderInstanceId.make("codex");
        yield* mail.updateSettings({
          defaultModelSelection: { instanceId, model: "luna" },
          escalationModelSelection: { instanceId, model: "review" },
        });
        yield* mail.setTrust({ key: "category:notification", trust: "auto" });
        const threadId = yield* deliver({
          subject: "Activity report",
          body: "The report is attached.",
          at: "2026-11-01T06:00:00.000Z",
        });
        expect(yield* rowOf(threadId)).toMatchObject({
          state: "active",
          line: "Reviewed report",
          suggestion: { reason: "fyi" },
        });
      }),
      undefined,
      (model) => (model === "review" ? { summary: "Reviewed report" } : { confidence: 0 }),
    ),
  );

  it.effect("nudges only explicitly waiting threads from Sent history", () =>
    withMail(
      Effect.gen(function* () {
        const engine = yield* MailEngine.MailEngine;
        const store = yield* MailStore.MailStore;
        const mail = yield* MailService.MailService;
        const at = "2026-11-01T06:00:00.000Z";
        const result = yield* engine.ingest(
          {
            accountId,
            accountEmail: me,
            gmail: false,
            mailbox: "Sent",
            role: "sent",
            initial: true,
            backfill: false,
          },
          ["Finished", "Old question", "Follow up"].map((subject) =>
            message({ subject, from: me, at }),
          ),
        );
        for (const [index, entry] of result.newMessageIds.entries()) {
          yield* store.setMessageBody(entry.id, index === 1 ? "Can you confirm?" : "Thank you.");
        }
        yield* engine.afterBodies(result.threads);
        const waiting = result.threads[2]!;
        yield* mail.act(
          { threadIds: [waiting], action: { type: "wait_for_reply" } },
          { actor: "user" },
        );
        expect(
          (yield* store.repliedWaiting("2026-11-10T00:00:00.000Z")).map((thread) => thread.id),
        ).toEqual([waiting]);
        const liveQuestion = yield* deliver({
          subject: "Meeting time",
          body: "Does Thursday work?",
          from: me,
          at,
        });
        expect(yield* rowOf(liveQuestion)).toMatchObject({
          state: "working",
          workingReason: "waiting",
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
          ["draft", "Inbox helper", false],
          ["propose", "Inbox helper", true],
        ]);
        expect((yield* mail.undo(log.actions[0]!.id).pipe(Effect.flip)).code).toBe("invalid");
        yield* mail.undo(log.actions[1]!.id);
        expect(yield* rowOf(threadId)).toMatchObject({ suggestion: null, hasDraft: true });
        expect((yield* mail.getThread(threadId)).drafts[0]?.body).toBe(edited.body);

        const input = {
          ...priorEdit,
          expectedRevision: edited.revision,
          body: "Updated by agent.",
        };
        expect(
          (yield* mail
            .saveDraft(
              {
                threadId,
                draftId: draft.id,
                to: draft.to,
                cc: draft.cc,
                subject: draft.subject,
                body: input.body,
              },
              agent,
            )
            .pipe(Effect.flip)).code,
        ).toBe("invalid");
        const revised = yield* mail.saveDraft(input, agent);
        const update = (yield* mail.listActions({ actor: "agent" })).actions[0]!;
        yield* mail.undo(update.id);
        expect((yield* mail.getThread(threadId)).drafts[0]).toMatchObject({
          body: edited.body,
          revision: revised.revision + 1,
        });
        const restored = (yield* mail.getThread(threadId)).drafts[0]!;
        yield* mail.discardDraft(restored.id, restored.revision);
        const discarded = (yield* mail.getThread(threadId)).actions[0]!;
        expect(discarded).toMatchObject({ kind: "draft", reason: "discard", undoable: true });
        yield* mail.undo(discarded.id);
        expect((yield* mail.getThread(threadId)).drafts[0]).toMatchObject({
          id: restored.id,
          body: edited.body,
          revision: restored.revision + 1,
        });
      }),
    ),
  );
  it.effect("rolls back a mail change when writing its history fails", () =>
    withMail(
      Effect.gen(function* () {
        const mail = yield* MailService.MailService;
        const store = yield* MailStore.MailStore;
        const threadId = yield* deliver({ subject: "Project update", body: "Ready", at });
        const request = { threadIds: [threadId], action: { type: "pin" } } as const;
        const user = { actor: "user" } as const;
        using _log = vi
          .spyOn(store, "insertAction")
          .mockReturnValueOnce(Effect.die("history write failed"));
        expect((yield* mail.act(request, user).pipe(Effect.exit))._tag).toBe("Failure");
        expect((yield* rowOf(threadId)).pinnedAt).toBeNull();
        const { actionIds } = yield* mail.act(request, user);
        using _undo = vi
          .spyOn(store, "markActionUndone")
          .mockReturnValueOnce(Effect.die("history write failed"));
        expect((yield* mail.undo(actionIds[0]!).pipe(Effect.exit))._tag).toBe("Failure");
        expect((yield* rowOf(threadId)).pinnedAt).not.toBeNull();
        yield* mail.undo(actionIds[0]!);
        expect((yield* rowOf(threadId)).pinnedAt).toBeNull();
      }),
    ),
  );

  it.effect("rejects approval of a superseded suggestion", () =>
    withMail(
      Effect.gen(function* () {
        const mail = yield* MailService.MailService;
        const threadId = yield* deliver({ subject: "Build", body: "Passed.", at });
        yield* mail.propose({ threadIds: [threadId], reason: "fyi" }, { actor: "agent" });
        const reviewed = (yield* rowOf(threadId)).suggestion!;
        yield* mail.propose({ threadIds: [threadId], reason: "noise" }, { actor: "agent" });
        const approval = { type: "approve", revisions: { [threadId]: reviewed.revision } } as const;
        expect(
          (yield* mail
            .act({ threadIds: [threadId], action: approval }, { actor: "user" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* rowOf(threadId)).toMatchObject({
          state: "active",
          suggestion: { reason: "noise" },
        });
      }),
    ),
  );

  it.effect("keeps the latest explicit trust choice when an older approval is undone", () =>
    withMail(
      Effect.gen(function* () {
        const mail = yield* MailService.MailService;
        const user = { actor: "user" } as const;
        const key = "sender:updates@acme.dev";
        const threadId = yield* deliver({ subject: "Status report", body: "Ready", at });
        yield* mail.propose({ threadIds: [threadId], reason: "fyi" }, { actor: "agent" });
        const approved = yield* mail.act(
          {
            threadIds: [threadId],
            action: {
              type: "approve",
              revisions: {
                [threadId]: (yield* rowOf(threadId)).suggestion?.revision ?? "already-settled",
              },
            },
          },
          user,
        );
        yield* mail.setTrust({ key, trust: "auto" });
        const level = (yield* mail.listActions({ actor: "user" })).actions[0]!;
        yield* mail.setTrust({ key, trust: "suggest" });
        expect((yield* mail.undo(level.id).pipe(Effect.flip)).code).toBe("invalid");
        yield* mail.undo(approved.actionIds[0]!);
        expect((yield* mail.listTrust).records.find((row) => row.key === key)).toMatchObject({
          trust: "suggest",
          explicit: true,
          approvals: 0,
          streak: 0,
        });
      }),
    ),
  );

  it.effect("undo preserves later actions and refuses to hide a new reply", () =>
    withMail(
      Effect.gen(function* () {
        const mail = yield* MailService.MailService;
        const engine = yield* MailEngine.MailEngine;
        const store = yield* MailStore.MailStore;
        const user = { actor: "user" } as const;
        const threadId = yield* deliver({
          subject: "Status",
          body: "Ready",
          at: "2026-11-01T12:00:00.000Z",
        });
        const proposed = yield* mail.propose(
          { threadIds: [threadId], reason: "done" },
          { actor: "agent" },
        );
        const pin = yield* mail.act({ threadIds: [threadId], action: { type: "pin" } }, user);
        yield* mail.undo(proposed.actionIds[0]!);
        expect((yield* rowOf(threadId)).pinnedAt).not.toBeNull();
        const read = yield* mail.act(
          { threadIds: [threadId], action: { type: "mark_read" } },
          user,
        );
        expect((yield* mail.getThread(threadId)).messages[0]?.unread).toBe(false);
        expect((yield* mail.getThread(threadId)).actions[0]).toMatchObject({
          kind: "mark_read",
          undoable: true,
        });
        yield* mail.undo(read.actionIds[0]!);
        expect((yield* mail.getThread(threadId)).messages[0]?.unread).toBe(true);
        yield* mail.undo(pin.actionIds[0]!);
        yield* mail.act({ threadIds: [threadId], action: { type: "settle" } }, user);
        const moved = yield* mail.act(
          { threadIds: [threadId], action: { type: "unsettle" } },
          user,
        );
        const first = (yield* store.threadMessages(threadId))[0]!;
        yield* engine.ingest(
          {
            accountId,
            accountEmail: me,
            gmail: false,
            mailbox: "INBOX",
            role: "primary",
            initial: false,
            backfill: false,
          },
          [
            {
              ...message({ subject: "Re: Status", at: "2026-11-02T12:00:00.000Z" }),
              inReplyTo: first.messageId,
            },
          ],
        );
        expect(
          (yield* mail.getThread(threadId)).actions.find(
            (action) => action.id === moved.actionIds[0],
          )?.undoable,
        ).toBe(false);
        expect((yield* mail.undo(moved.actionIds[0]!).pipe(Effect.flip)).code).toBe("invalid");
        expect(yield* rowOf(threadId)).toMatchObject({
          state: "active",
          messageCount: 2,
          unread: true,
        });
      }),
    ),
  );
});

const addSendingAccount = Effect.gen(function* () {
  const store = yield* MailStore.MailStore;
  const credentials = yield* MailCredentials.MailCredentials;
  const credentialStore = yield* credentials.put(accountId, "test", "file");
  yield* store.insertAccount({
    id: accountId,
    email: me,
    displayName: "Nick",
    username: me,
    provider: "imap",
    imapHost: "imap.invalid",
    imapPort: 993,
    imapTls: true,
    smtpHost: "smtp.invalid",
    smtpPort: 465,
    smtpTls: true,
    credentialStore,
    keychainPossible: false,
    credentialPending: false,
    status: "idle",
    statusDetail: null,
    lastSyncAt: null,
    backfillPausedUntil: null,
    createdAt: at,
  });
});

describe("MailService model usage and replies", () => {
  it.effect("charges weekly mail chat turns once alongside estimated text generation", () =>
    withMail(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const engine = yield* MailEngine.MailEngine;
        const store = yield* MailStore.MailStore;
        const { weekStart } = yield* engine.usage;
        const previousWeek = "1969-01-01T00:00:00.000Z";
        for (const [thread, project] of [
          ["mail", "t3-mail-sessions"],
          ["code", "other"],
        ]) {
          yield* sql`INSERT INTO orchestration_v2_projection_threads
            (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
            VALUES (${thread}, ${project}, 'Test', 'codex', 'default', 'default', ${previousWeek}, ${weekStart}, '{}')`;
        }
        const reported = {
          usageStatus: "complete",
          inputTokens: 32,
          outputTokens: 8,
          cachedInputTokens: 24,
          cacheCreationTokens: 1,
          reasoningTokens: 7,
        };
        const turns = [
          ["mail", weekStart, reported],
          ["mail", weekStart, { usageStatus: "partial", outputTokens: 5 }],
          ["mail", previousWeek, reported],
          ["code", weekStart, reported],
          ["mail", null, reported],
          ["mail", weekStart, undefined],
          ["mail", weekStart, { ...reported, localCommand: true }],
        ] as const;
        for (const [i, [thread, completedAt, turnTokenUsage]] of turns.entries()) {
          const payload = JSON.stringify({ turnTokenUsage, tokenUsage: { usedTokens: 1000 } });
          yield* sql`INSERT INTO orchestration_v2_projection_provider_turns
            (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, completed_at, payload_json)
            VALUES (${String(i)}, ${thread}, ${thread}, 'node', ${i}, 'completed', ${completedAt}, ${payload})`;
        }
        yield* engine.putSettings({ ...(yield* engine.settings), weeklyTokenCap: 55 });
        yield* store.insertUsage({
          at: weekStart,
          kind: "l1",
          model: "test",
          tokens: 10,
          emails: 2,
        });
        const expected = { tokens: 55, estimatedTokens: 10, calls: 3, emails: 2, capped: true };
        expect(yield* engine.usage).toMatchObject(expected);
        expect((yield* engine.status).usage).toMatchObject(expected);
        yield* sql`UPDATE orchestration_v2_projection_provider_turns
          SET payload_json = json_set(payload_json, '$.turnTokenUsage.inputTokens', 28)
          WHERE provider_turn_id = '0'`;
        expect(yield* engine.usage).toMatchObject({ ...expected, tokens: 51, capped: false });
      }),
    ),
  );

  it.effect(
    "stops before escalating or starting another batch when L1 crosses the weekly cap",
    () =>
      withMail(
        Effect.gen(function* () {
          const mail = yield* MailService.MailService;
          const store = yield* MailStore.MailStore;
          const engine = yield* MailEngine.MailEngine;
          yield* mail.updateSettings({
            weeklyTokenCap: 1,
            defaultModelSelection: modelSelection,
            escalationModelSelection: modelSelection,
          });
          const sender = "sam@example.org";
          yield* store.sql`INSERT INTO mail_contacts (account_id, address) VALUES (${accountId}, ${sender})`;
          const batch = yield* engine.ingest(
            {
              accountId,
              accountEmail: me,
              gmail: false,
              mailbox: "INBOX",
              role: "primary",
              initial: false,
              backfill: false,
            },
            Array.from({ length: 13 }, (_, i) =>
              message({ subject: `Question ${i}`, from: sender, at }),
            ),
          );
          for (const entry of batch.newMessageIds)
            yield* store.setMessageBody(entry.id, "Could you review this?");
          yield* engine.afterBodies(batch.threads);
          yield* mail.drainTriage;
          expect(yield* engine.usage).toMatchObject({ capped: true, calls: 1, emails: 12 });
          const threads = yield* store.getThreads(batch.threads);
          expect(threads.filter((thread) => thread.verdict?.source === "model")).toHaveLength(12);
          expect(threads.filter((thread) => thread.triageState === "capped")).toHaveLength(1);
          yield* mail.updateSettings({ weeklyTokenCap: null });
          yield* mail.drainTriage;
          expect(
            (yield* store.getThreads(batch.threads)).filter(
              (thread) => thread.triageState === "capped",
            ),
          ).toHaveLength(0);
          expect(yield* engine.usage).toMatchObject({ calls: 3, emails: 14 });
        }),
      ),
  );

  it.effect(
    "keeps distinct local copies of replies sent at the same instant and reconciles their IMAP copies",
    () =>
      withMail(
        Effect.gen(function* () {
          const mail = yield* MailService.MailService;
          const store = yield* MailStore.MailStore;
          yield* addSendingAccount;
          const threadId = yield* deliver({ subject: "Lunch", body: "Tomorrow?", at });
          const bodies = ["Wednesday works for me.", "Let's meet at noon."];
          const drafts = yield* Effect.forEach(bodies, (body) =>
            mail.saveDraft(
              {
                threadId,
                to: ["sam@example.org"],
                cc: [],
                subject: "Re: Lunch",
                body,
              },
              { actor: "user" },
            ),
          );
          yield* Effect.forEach(
            drafts,
            (draft) => mail.sendDraft({ draftId: draft.id, revision: draft.revision }),
            { concurrency: "unbounded" },
          );
          const local = (yield* store.threadMessages(threadId)).filter(
            (message) => message.outgoing,
          );
          expect(local.map((message) => message.body).sort()).toEqual([...bodies].sort());
          expect(new Set(local.map((message) => message.uid)).size).toBe(2);
          for (const [index, message] of local.entries()) {
            expect(message.uid).toBeLessThan(0);
            expect(
              yield* store.upsertMessage({ ...message, mailbox: "Sent", uid: index + 1 }),
            ).toEqual({
              id: message.id,
              inserted: false,
            });
          }
          expect(
            (yield* store.threadMessages(threadId)).filter((message) => message.mailbox === "Sent"),
          ).toHaveLength(2);
        }),
      ),
  );

  it.effect("requires fresh approval for only the rejected recipients of a partial delivery", () =>
    withMail(
      Effect.gen(function* () {
        const mail = yield* MailService.MailService;
        const store = yield* MailStore.MailStore;
        yield* addSendingAccount;
        const threadId = yield* deliver({ subject: "Review", body: "Ready", at });
        const to = "one@example.org";
        const cc = "two@example.org";
        const draft = yield* mail.saveDraft(
          { threadId, to: [to], cc: [cc], subject: "Re: Review", body: "Thanks" },
          { actor: "user" },
        );
        using send = vi
          .spyOn(Smtp, "sendRaw")
          .mockResolvedValueOnce({ accepted: [to], rejected: [cc] })
          .mockResolvedValueOnce({ accepted: [cc], rejected: [] });
        const remainder = yield* mail.sendDraft({ draftId: draft.id, revision: draft.revision });
        expect(remainder).toMatchObject({
          status: "failed",
          to: [],
          cc: [cc],
          revision: draft.revision + 1,
        });
        expect(remainder.error).toContain(to);
        expect(remainder.error).toContain(cc);
        expect((yield* rowOf(threadId)).state).not.toBe("settled");
        expect(
          (yield* mail
            .sendDraft({ draftId: draft.id, revision: draft.revision })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* mail.sendDraft({ draftId: draft.id, revision: remainder.revision })).status,
        ).toBe("sent");
        expect(send.mock.calls.map(([, m]) => [...m.to, ...m.cc])).toEqual([[to, cc], [cc]]);
        expect((yield* store.threadMessages(threadId)).filter((m) => m.outgoing)).toHaveLength(2);
      }),
    ),
  );

  it.effect("checks the weekly cap before generating voice notes", () =>
    withMail(
      Effect.gen(function* () {
        const mail = yield* MailService.MailService;
        const engine = yield* MailEngine.MailEngine;
        yield* deliver({
          subject: "Sent reply",
          from: me,
          body: "Wednesday afternoon works for me.",
          at,
        });
        yield* mail.updateSettings({ weeklyTokenCap: 0, defaultModelSelection: modelSelection });
        expect((yield* mail.seedVoice.pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* engine.usage).calls).toBe(0);
        yield* mail.updateSettings({ weeklyTokenCap: 1 });
        const request = mail.seedVoice.pipe(Effect.result);
        const results = yield* Effect.all([request, request], { concurrency: "unbounded" });
        expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"]);
        expect((yield* engine.usage).calls).toBe(1);
      }),
    ),
  );

  it.effect(
    "reuses reply edits only for the same account and sender and ignores global examples",
    () => {
      const prompts: string[] = [];
      return withMail(
        Effect.gen(function* () {
          const mail = yield* MailService.MailService;
          const store = yield* MailStore.MailStore;
          yield* addSendingAccount;
          yield* store.setKv(
            "draft-edits",
            JSON.stringify([{ before: "legacy secret", after: "legacy secret" }]),
          );
          const sender = "sam@example.org";
          const threadId = yield* deliver({
            subject: "Monday",
            from: sender,
            body: "What time?",
            at,
          });
          const before = "Internal draft wording";
          const after = "Private revised wording";
          const input = { threadId, to: [sender], cc: [], subject: "Re: Monday" };
          const draft = yield* mail.saveDraft({ ...input, body: before }, { actor: "agent" });
          const edited = yield* mail.saveDraft(
            { ...input, draftId: draft.id, body: after },
            { actor: "user" },
          );
          yield* mail.sendDraft({ draftId: draft.id, revision: edited.revision });
          const group = { ...input, cc: ["lee@example.org"] };
          const groupDraft = yield* mail.saveDraft({ ...group, body: before }, { actor: "agent" });
          const groupEdit = yield* mail.saveDraft(
            { ...group, draftId: groupDraft.id, body: "Private group wording" },
            { actor: "user" },
          );
          yield* mail.sendDraft({ draftId: groupEdit.id, revision: groupEdit.revision });
          for (const [account, from] of [
            [accountId, sender.toUpperCase()],
            [accountId, "lee@example.org"],
            [MailAccountId.make("other-account"), sender],
          ] as const) {
            const next = yield* deliver({
              account,
              from,
              subject: "Schedule",
              body: "Next meeting?",
              at,
            });
            if (account !== accountId) expect((yield* mail.getThread(next)).related).toEqual([]);
            yield* mail.openSession({ threadId: next, modelSelection });
          }
          expect(prompts).toHaveLength(3);
          expect(prompts[0]).toContain(before);
          expect(prompts[0]).toContain(after);
          for (const prompt of prompts.slice(1)) {
            expect(prompt).not.toContain(before);
            expect(prompt).not.toContain(after);
          }
          for (const prompt of prompts) {
            expect(prompt).not.toContain("legacy secret");
            expect(prompt).not.toContain("Private group wording");
          }
        }),
        (prompt) => prompts.push(prompt),
      );
    },
  );
});

it.effect("preserves thread state until each UIDVALIDITY rebuild has finished", () =>
  withMail(
    Effect.gen(function* () {
      const store = yield* MailStore.MailStore;
      const engine = yield* MailEngine.MailEngine;
      const inbox = {
        accountId,
        accountEmail: me,
        gmail: false,
        mailbox: "INBOX",
        role: "primary" as const,
        initial: true,
        backfill: false,
      };
      const sent = { ...inbox, role: "sent" as const, mailbox: "Sent" };
      const original = message({ subject: "Keep this conversation", at: "2026-11-01T08:00:00Z" });
      const missing = message({ subject: "Removed from the rebuilt inbox", at: original.date });
      const followUp = {
        ...message({ subject: "Re: Keep this conversation", at: original.date }),
        inReplyTo: original.messageId,
      };
      const lateReply = {
        ...message({ subject: followUp.subject, at: original.date }),
        inReplyTo: followUp.messageId,
      };
      const [kept, lost] = (yield* engine.ingest(inbox, [original, followUp, lateReply, missing]))
        .threads;
      if (!kept || !lost) throw new Error("Missing seeded threads");
      yield* store.patchThread(kept, {
        state: "snoozed",
        pinnedAt: original.date,
        snoozeOnReply: true,
      });
      yield* store.setChatThread(kept, "chat-to-keep");
      yield* engine.ingest(sent, [{ ...original, uid: 1 }]);
      yield* store.resetMailbox(accountId, "INBOX");

      yield* engine.markRemoved(inbox, []);
      yield* engine.markRemoved(sent, [1]);
      expect(yield* store.getThread(kept)).toMatchObject({ chatThreadId: "chat-to-keep" });
      yield* store.resetMailbox(accountId, "Sent");
      yield* engine.finishMailboxReset(accountId, "Sent");
      expect(yield* store.getThread(lost)).not.toBeNull();

      yield* engine.ingest({ ...inbox, initial: false, backfill: true }, [
        { ...lateReply, uid: 37 },
      ]);
      yield* engine.finishMailboxReset(accountId, "INBOX");
      expect(yield* store.getThread(kept)).toMatchObject({
        state: "snoozed",
        pinnedAt: original.date,
        chatThreadId: "chat-to-keep",
        messageCount: 1,
      });
      expect(yield* store.getThread(lost)).toBeNull();
      yield* engine.markRemoved(inbox, [37]);
      expect(yield* store.getThread(kept)).toBeNull();
    }),
  ),
);

it.effect(
  "leaves unchanged polled flags untouched and aggregates distinct messages from metadata",
  () =>
    withMail(
      Effect.gen(function* () {
        const store = yield* MailStore.MailStore;
        const threadId = yield* deliver({ subject: "Poll", body: "Hello", at });
        const first = (yield* store.threadMessages(threadId))[0]!;
        expect(
          yield* store.updateFlags(accountId, "INBOX", [
            { uid: first.uid, seen: false, labels: null },
          ]),
        ).toEqual([]);
        yield* store.upsertMessage({ ...first, mailbox: "Copy", uid: 1, seen: true });
        yield* store.upsertMessage({
          ...first,
          date: "2026-11-21T11:00:00Z",
          uid: first.uid + 1,
          messageId: null,
          subject: "Re: Poll",
          from: { name: "Me", address: me },
          outgoing: true,
        });
        expect(yield* store.refreshThreadAggregate(threadId)).toMatchObject({
          messageCount: 2,
          incomingCount: 1,
          subject: first.subject,
          fromName: first.from.name,
          lastIncomingAt: first.date,
          lastOutgoingAt: "2026-11-21T11:00:00Z",
          unread: true,
        });
        expect(
          yield* store.updateFlags(accountId, "INBOX", [
            { uid: first.uid, seen: true, labels: null },
          ]),
        ).toEqual([threadId]);
        expect(yield* store.refreshThreadAggregate(threadId)).toMatchObject({ unread: false });
      }),
    ),
);

describe("MailService accounts", () => {
  it.effect(
    "rotates between stores, including a keychain write that fails after storing the password",
    () => {
      let nativePassword: string | undefined;
      let filePassword: Uint8Array | undefined;
      let writable = false;
      let readable = false;
      let allowDelete = false;
      const credentials = MailCredentials.layerWithKeyring(() => ({
        getPassword: async () => {
          if (!readable) throw new Error("Locked fixture");
          return nativePassword;
        },
        setPassword: async (password) => {
          nativePassword = password;
          if (!writable) throw new Error("Could not verify fixture write");
        },
        deletePassword: async () => {
          if (allowDelete) nativePassword = undefined;
        },
      })).pipe(
        Layer.provide(
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: () => Effect.succeed(Option.fromNullishOr(filePassword)),
            set: (_, bytes) =>
              Effect.sync(() => {
                filePassword = bytes;
              }),
            remove: () =>
              Effect.sync(() => {
                filePassword = undefined;
              }),
          }),
        ),
      );
      return withMail(
        Effect.gen(function* () {
          using _verify = vi.spyOn(ImapSession, "verifyLogin").mockResolvedValue({ gmail: false });
          const mail = yield* MailService.MailService;
          const store = yield* MailStore.MailStore;
          const account = yield* mail.addAccount({
            email: "fixture@example.org",
            appPassword: "first",
            connection: {
              username: "fixture",
              imapHost: "imap.invalid",
              imapPort: 993,
              imapTls: true,
              smtpHost: "smtp.invalid",
              smtpPort: 465,
              smtpTls: true,
            },
          });
          expect(account.credentialStore).toBe("file");
          expect(new TextDecoder().decode(filePassword)).toBe("first");
          readable = true;
          writable = true;
          const rotate = (password: string) =>
            mail.updateAccount({ accountId: account.id, appPassword: password });
          expect((yield* rotate("second")).credentialStore).toBe("keychain");
          expect(nativePassword).toBe("second");
          expect(filePassword).toBeUndefined();

          writable = false;
          expect((yield* rotate("third").pipe(Effect.result))._tag).toBe("Failure");
          expect(nativePassword).toBe("third");
          expect(new TextDecoder().decode(filePassword)).toBe("third");
          expect(yield* store.getAccount(account.id)).toMatchObject({
            credentialStore: "file",
            keychainPossible: true,
            credentialPending: true,
            status: "error",
          });
          expect((yield* mail.syncNow(account.id).pipe(Effect.result))._tag).toBe("Failure");
          allowDelete = true;
          expect((yield* rotate("fourth")).credentialStore).toBe("file");
          expect(nativePassword).toBeUndefined();
          expect(new TextDecoder().decode(filePassword)).toBe("fourth");
          readable = false;
          yield* mail.removeAccount(account.id);
          expect(filePassword).toBeUndefined();
        }),
        undefined,
        undefined,
        credentials,
      );
    },
  );

  it.effect(
    "retains the account on a cleanup failure and removes both password copies on retry",
    () => {
      const copies = new Set(["file", "keychain"]);
      let locked = true;
      const credentials = Layer.mock(MailCredentials.MailCredentials)({
        remove: (id, backend) =>
          Effect.suspend(() => {
            if (backend === "keychain" && locked) {
              return Effect.fail(
                new MailCredentials.MailCredentialError({
                  accountId: id,
                  backend,
                  operation: "remove",
                  cause: "locked",
                }),
              );
            }
            copies.delete(backend);
            return Effect.void;
          }),
      });
      return withMail(
        Effect.gen(function* () {
          const mail = yield* MailService.MailService;
          const store = yield* MailStore.MailStore;
          // A pre-migration file account may also have a leftover native credential.
          yield* store.sql`INSERT INTO mail_accounts (id, email, display_name, provider, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, username, credential_store, status, created_at)
        VALUES (${accountId}, 'fixture@example.org', '', 'imap', '', 993, 1, '', 465, 1, '', 'file', 'idle', '')`;
          const result = yield* mail.removeAccount(accountId).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          expect(yield* store.getAccount(accountId)).toMatchObject({ status: "error" });
          locked = false;
          yield* mail.removeAccount(accountId);
          yield* mail.removeAccount(accountId);
          expect(copies.size).toBe(0);
          expect(yield* store.getAccount(accountId)).toBeNull();
        }),
        undefined,
        undefined,
        credentials,
      );
    },
  );

  it.effect(
    "removes account contacts, learned edits and exclusive trust while keeping other accounts' records",
    () =>
      withMail(
        Effect.gen(function* () {
          const store = yield* MailStore.MailStore;
          const other = MailAccountId.make("acct-other");
          for (const id of [accountId, other]) {
            yield* store.sql`INSERT INTO mail_contacts VALUES (${id}, 'contact@example.org')`;
            yield* store.sql`INSERT INTO mail_drafts (id, thread_id, account_id, to_json, cc_json, subject, body, origin, original_body, status, updated_at, edit_sender)
          VALUES (${id}, ${id}, ${id}, '[]', '[]', '', 'two', 'agent', 'one', 'sent', ${at}, 'contact@example.org')`;
          }
          yield* store.setKv("draft-edits", '[{"before":"legacy","after":"unattributed"}]');
          const mail = yield* MailService.MailService;
          yield* mail.updateSettings({
            defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "luna" },
          });
          const id = yield* deliver({
            subject: "Nightly build",
            body: "Succeeded.",
            at: "2026-11-01T06:00:00.000Z",
          });
          yield* mail.act(
            {
              threadIds: [id],
              action: {
                type: "approve",
                revisions: { [id]: (yield* rowOf(id)).suggestion!.revision },
              },
            },
            { actor: "user" },
          );
          expect((yield* mail.listTrust).records.length).toBeGreaterThan(0);
          yield* addSendingAccount;
          const shared = yield* deliver({
            account: other,
            subject: "Build on a different account",
            from: "ops@elsewhere.org",
            body: "Succeeded.",
            at,
          });
          yield* mail.act(
            {
              threadIds: [shared],
              action: {
                type: "approve",
                revisions: { [shared]: (yield* rowOf(shared)).suggestion!.revision },
              },
            },
            { actor: "user" },
          );
          yield* store.setChatThread(id, ThreadId.make("fixture-chat"));
          yield* store.setKv("chat-context:fixture-chat", "receipt");
          yield* mail.removeAccount(accountId);
          expect(yield* store.getKv("chat-context:fixture-chat")).toBeNull();
          expect((yield* store.repliedToAddresses(accountId, ["contact@example.org"])).size).toBe(
            0,
          );
          expect((yield* store.repliedToAddresses(other, ["contact@example.org"])).size).toBe(1);
          expect(yield* store.recentReplyEdits(accountId, "contact@example.org")).toEqual([]);
          expect(yield* store.getKv("draft-edits")).toBeNull();
          expect(yield* store.recentReplyEdits(other, "contact@example.org")).toEqual([
            { before: "one", after: "two" },
          ]);
          expect((yield* mail.listTrust).records.map((record) => record.key).sort()).toEqual([
            "category:notification",
            "sender:ops@elsewhere.org",
          ]);
        }),
      ),
  );
});

it.effect("undo mirrors only messages that settle found in the inbox", () =>
  withMail(
    Effect.gen(function* () {
      const store = yield* MailStore.MailStore;
      const mail = yield* MailService.MailService;
      yield* mail.updateSettings({ serverMirroring: true });
      yield* store.putMailbox({
        accountId,
        path: "INBOX",
        role: "primary",
        uidValidity: "101",
        maxUid: 4,
        minUid: 1,
        highestModseq: null,
        backfillDone: true,
      });
      const threadId = yield* deliver({ subject: "Mirror", body: "Hello", at });
      const original = (yield* store.threadMessages(threadId))[0]!;
      yield* store.upsertMessage({
        ...original,
        uid: original.uid + 1,
        messageId: "<archived>",
        inInbox: false,
        seen: true,
      });
      const { actionIds } = yield* mail.act(
        { threadIds: [threadId], action: { type: "settle" } },
        { actor: "user" },
      );
      yield* mail.undo(actionIds[0]!);
      const read = yield* mail.act(
        { threadIds: [threadId], action: { type: "mark_read" } },
        { actor: "user" },
      );
      expect(
        yield* store.updateFlags(accountId, "INBOX", [
          { uid: original.uid, seen: false, labels: null },
        ]),
      ).toEqual([]);
      yield* store.upsertMessage({
        ...original,
        uid: original.uid + 2,
        messageId: "<later-reply>",
      });
      yield* mail.undo(read.actionIds[0]!);
      const ops = yield* store.pendingOps(accountId);
      expect(ops.map((op) => op.kind)).toEqual(["archive", "unarchive", "seen", "seen"]);

      const calls: Array<readonly [string, ReadonlyArray<number>]> = [];
      const record = (operation: string, uids: ReadonlyArray<number>) => {
        calls.push([operation, uids]);
        return Promise.resolve();
      };
      let primaryEpoch = "101";
      const session: Parameters<typeof replayOp>[3] = {
        withMailbox: (path, _known, work) =>
          work({
            uidValidity: path === "INBOX" ? primaryEpoch : "202",
            exists: 3,
            uidNext: 90,
            highestModseq: null,
          }),
        setSeen: (uids, seen) => record(String(seen), uids),
        setInboxLabel: (uids, inbox) => record(inbox ? "add label" : "remove label", uids),
        move: async (uids, to) => {
          await record(to, uids);
          return {
            uidValidity: to === "INBOX" ? primaryEpoch : "202",
            uidMap: new Map(uids.map((uid) => [uid, uid + 10])),
          };
        },
        ensureMailbox: () => Promise.resolve(),
        append: () => Promise.resolve(),
      };
      const roles = { primary: "INBOX", sent: null, archive: "Archive", gmail: true };
      const replay = (gmail: boolean) =>
        Effect.forEach(ops, (op) => replayOp(accountId, op.payload, { ...roles, gmail }, session));
      yield* replay(true);
      expect(calls.splice(0)).toEqual([
        ["remove label", [original.uid]],
        ["add label", [original.uid]],
        ["true", [original.uid]],
        ["false", [original.uid]],
      ]);
      yield* replay(false);
      expect(calls.splice(0)).toEqual([
        ["Archive", [original.uid]],
        ["INBOX", [original.uid + 10]],
        ["true", [original.uid + 20]],
        ["false", [original.uid + 20]],
      ]);
      primaryEpoch = "303";
      yield* replay(true);
      yield* store.resetMailbox(accountId, "INBOX");
      yield* store.putMailbox({
        accountId,
        path: "INBOX",
        role: "primary",
        uidValidity: primaryEpoch,
        maxUid: original.uid,
        minUid: original.uid,
        highestModseq: null,
        backfillDone: true,
      });
      const replacement = yield* store.upsertMessage({ ...original, messageId: "<uid-reused>" });
      expect(replacement.id).toBe(original.id);
      yield* replay(true);
      yield* replayOp(accountId, `{"kind":"archive","threadId":"${threadId}"}`, roles, session);
      expect(calls).toEqual([]);
    }),
  ),
);

it.effect("notifies once for new unread inbox mail and skips backfill and repeat fetches", () =>
  withMail(
    Effect.gen(function* () {
      const engine = yield* MailEngine.MailEngine;
      const context = {
        accountId,
        accountEmail: me,
        gmail: false,
        mailbox: "INBOX",
        role: "primary",
        initial: false,
        backfill: false,
      } as const;
      const arriving = yield* engine.arrivals.pipe(
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      const historical = message({ subject: "Historical notice", at });
      yield* engine.ingest({ ...context, backfill: true }, [historical]);
      yield* engine.ingest(context, [
        historical,
        { ...message({ subject: "Already read", at }), seen: true },
      ]);
      yield* engine.ingest(context, [
        message({ subject: "First new arrival", at }),
        message({ subject: "Second new arrival", at }),
      ]);
      expect(yield* Fiber.join(arriving)).toEqual(Option.some({ count: 2 }));
    }),
  ),
);

it("leaves quota-limited bodies pending and preserves earlier downloads", async () => {
  const rows = [1, 2, 3].map((id) => ({
    id,
    uid: id,
    thread_id: "m",
    text_part: '{"part":"1","html":false}',
  }));
  const fetchBody = vi
    .fn()
    .mockResolvedValueOnce("first")
    .mockRejectedValueOnce(new Error("OVERQUOTA"))
    .mockResolvedValue("resumed");
  const first = await MailSync.downloadBodies(rows, fetchBody);
  expect(first).toEqual({ quota: true, bodies: [{ id: 1, threadId: "m", body: "first" }] });
  expect(fetchBody).toHaveBeenCalledTimes(2);
  expect(
    (await MailSync.downloadBodies(rows.slice(1), fetchBody)).bodies.map((entry) => entry.id),
  ).toEqual([2, 3]);
});
