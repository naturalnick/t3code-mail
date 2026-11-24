import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MailThreadId,
  type MailActionEntry,
  type MailListActionsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as MailService from "../../../mail/MailService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as MailHandlers from "./handlers.ts";
import { MailToolkit } from "./tools.ts";

const entry = (overrides: Partial<MailActionEntry>): MailActionEntry => ({
  id: 1,
  at: "2026-11-20T09:00:00.000Z",
  actor: "ai",
  actorLabel: null,
  kind: "settle",
  threadId: null,
  subject: null,
  from: null,
  fromAddress: null,
  reason: null,
  undoable: true,
  undoneAt: null,
  ...overrides,
});

it.effect("reads the mail activity log and hides senders with AI off", () => {
  const requests: Array<MailListActionsInput> = [];
  return Effect.gen(function* () {
    const toolkit = yield* MailToolkit;
    const [result] = yield* toolkit
      .handle("t3_mail_activity", { automatic: true, beforeId: 40 })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(requests).toEqual([
      { includeSpamAndUnsubscribe: true, limit: 30, automatic: true, beforeId: 40 },
    ]);
    expect(result?.result).toEqual({
      entries: [
        {
          actionId: 3,
          at: "2026-11-20T09:00:00.000Z",
          actor: "rule",
          by: "Receipts",
          action: "settle",
          reason: "receipt",
          threadId: "thread-receipt",
          from: "Shop",
          subject: "Your order",
          undone: false,
        },
        {
          actionId: 2,
          at: "2026-11-20T09:00:00.000Z",
          actor: "ai",
          action: "settle",
          threadId: "thread-bank",
          from: "Bank",
          subject: "(hidden: the user turned AI off for this sender)",
          undone: true,
        },
        {
          actionId: 1,
          at: "2026-11-20T09:00:00.000Z",
          actor: "mail",
          action: "delete",
          reason: "sign_in_code",
          undone: false,
        },
      ],
      hasMore: true,
    });
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(MailHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:mail"),
              requestNamespace: "provider:mail",
              thread: undefined,
              client: undefined,
              capabilities: new Set(["orchestration" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(MailService.MailService)({
              aiExcluded: Effect.succeed((address) => address === "alerts@bank.example"),
              listActions: (input) =>
                Effect.sync(() => {
                  requests.push(input);
                  return {
                    actions: [
                      entry({
                        id: 3,
                        actor: "rule",
                        actorLabel: "Receipts",
                        threadId: MailThreadId.make("thread-receipt"),
                        subject: "Your order",
                        from: "Shop",
                        fromAddress: "orders@shop.example",
                        reason: "receipt",
                      }),
                      entry({
                        id: 2,
                        threadId: MailThreadId.make("thread-bank"),
                        subject: "Statement ready",
                        from: "Bank",
                        fromAddress: "alerts@bank.example",
                        undoable: false,
                        undoneAt: "2026-11-20T10:00:00.000Z",
                      }),
                      entry({ id: 1, actor: "mail", kind: "delete", reason: "sign_in_code" }),
                    ],
                    hasMore: true,
                  };
                }),
            }),
          ),
        ),
      ),
    ),
  );
});
