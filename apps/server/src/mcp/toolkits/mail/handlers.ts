import {
  OrchestratorMcpFailure,
  type MailAddress,
  type MailError,
  type MailRule,
  type MailThreadRow,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MailService from "../../../mail/MailService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MailToolkit } from "./tools.ts";

const address = (entry: MailAddress) =>
  entry.name ? `${entry.name} <${entry.address}>` : entry.address;

const HIDDEN = "(hidden: the user turned AI off for this sender)";

const row = (thread: MailThreadRow, excluded: (address: string) => boolean) => ({
  threadId: thread.id,
  from: address(thread.from),
  subject: excluded(thread.from.address) ? HIDDEN : thread.subject,
  state: thread.state,
  lastMessageAt: thread.lastMessageAt,
  unread: thread.unread,
  hasDraft: thread.hasDraft,
  ...(thread.suggestion ? { suggestedSettle: thread.suggestion.reason } : {}),
});

const ruleRow = (rule: MailRule) => ({
  ruleId: rule.id,
  enabled: rule.enabled,
  match: rule.match,
  ...(rule.when ? { when: rule.when } : {}),
  ...(rule.addedBy ? { addedBy: rule.addedBy } : {}),
});

const failure = <A, R>(effect: Effect.Effect<A, MailError, R>) =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({
          code: error.code === "not_found" ? "invalid_request" : "orchestration_error",
          message: error.message,
        }),
    ),
  );

/** The log names who acted: the calling thread's title, or the MCP client's name. */
const agentActor = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread !== undefined) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const threadId = scope.thread.threadId;
    const title = yield* threads.getThreadTitles([threadId]).pipe(
      Effect.map((titles) => titles[threadId]),
      Effect.orElseSucceed(() => undefined),
    );
    return { actor: "agent" as const, label: title ?? "Agent" };
  }
  return { actor: "agent" as const, label: scope.client?.label ?? "Agent" };
});

export const layer = McpToolAccess.toLayer(MailToolkit, {
  t3_mail_list: McpToolAccess.reads(({ state, query, limit }) =>
    Effect.gen(function* () {
      const mail = yield* MailService.MailService;
      const excluded = yield* failure(mail.aiExcluded);
      const max = limit ?? 30;
      const threads =
        query !== undefined && query.trim().length > 0
          ? (yield* failure(mail.search({ query, limit: max }))).threads
          : yield* failure(mail.listThreads(state ?? "active", max));
      return { threads: threads.map((thread) => row(thread, excluded)) };
    }),
  ),
  t3_mail_read: McpToolAccess.reads(({ threadId }) =>
    Effect.gen(function* () {
      const mail = yield* MailService.MailService;
      const excluded = yield* failure(mail.aiExcluded);
      const detail = yield* failure(mail.getThread(threadId));
      if (excluded(detail.thread.from.address))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The user turned AI off for this sender, so this thread can't be read.",
        });
      const related = yield* failure(
        Effect.forEach(detail.related, (entry) => mail.getThread(entry.id)),
      );
      return {
        subject: detail.thread.subject,
        state: detail.thread.state,
        messages: detail.messages.map((message) => ({
          messageId: message.id,
          from: address(message.from),
          to: message.to.map(address),
          cc: message.cc.map(address),
          date: message.date,
          fromUser: message.outgoing,
          text:
            !message.outgoing && excluded(message.from.address)
              ? HIDDEN
              : (message.text ?? "(not downloaded yet)"),
          attachments: message.attachments.map((attachment) => attachment.filename),
        })),
        drafts: detail.drafts
          .filter((draft) => draft.status !== "sent")
          .map((draft) => ({
            draftId: draft.id,
            revision: draft.revision,
            mode: draft.mode,
            targetMessageId: draft.targetMessageId,
            to: draft.to,
            cc: draft.cc,
            subject: draft.subject,
            body: draft.body,
            status: draft.status,
          })),
        related: related.map((entry) => row(entry.thread, excluded)),
      };
    }),
  ),
  t3_mail_draft: McpToolAccess.writes(
    ({ threadId, body, draftId, expectedRevision, to, cc, subject, targetMessageId, mode }) =>
      Effect.gen(function* () {
        const mail = yield* MailService.MailService;
        const detail = yield* failure(mail.getThread(threadId));
        const existing = detail.drafts.find((draft) => draft.id === draftId);
        const chosenId = targetMessageId ?? existing?.targetMessageId ?? null;
        const target =
          (chosenId === null
            ? undefined
            : detail.messages.find((message) => message.id === chosenId)) ??
          detail.messages.findLast((message) => !message.outgoing) ??
          detail.messages.at(-1);
        const forward = (mode ?? existing?.mode) === "forward";
        // A reply goes to Reply-To or the sender; on your own message, to the people you wrote to.
        const replyTo = !target
          ? []
          : target.outgoing
            ? target.to
            : target.replyTo.length > 0
              ? target.replyTo
              : [target.from];
        const subjectLine = target?.subject || detail.thread.subject;
        const prefix = forward ? /^(fwd?|fw):/i : /^re:/i;
        const draft = yield* failure(
          mail.saveDraft(
            {
              threadId,
              ...(draftId === undefined ? {} : { draftId }),
              ...(expectedRevision === undefined ? {} : { expectedRevision }),
              to: to ?? existing?.to ?? (forward ? [] : replyTo.map((entry) => entry.address)),
              cc: cc ?? existing?.cc ?? [],
              subject:
                subject ??
                (mode === undefined ? existing?.subject : undefined) ??
                // A new email has nothing to answer, so its subject is its own.
                (target === undefined || prefix.test(subjectLine)
                  ? subjectLine
                  : `${forward ? "Fwd" : "Re"}: ${subjectLine}`),
              body,
              mode: forward ? "forward" : "reply",
              ...(target ? { targetMessageId: target.id } : {}),
            },
            yield* agentActor,
          ),
        );
        return { draftId: draft.id, revision: draft.revision };
      }),
  ),
  t3_mail_rules: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const mail = yield* MailService.MailService;
      return { rules: (yield* failure(mail.rules)).map(ruleRow) };
    }),
  ),
  t3_mail_rule: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const mail = yield* MailService.MailService;
      const rules = yield* failure(mail.saveRule(input, yield* agentActor));
      return { rules: rules.map(ruleRow) };
    }),
  ),
  t3_mail_triage: McpToolAccess.writes(({ threadIds, action, reason }) =>
    Effect.gen(function* () {
      const mail = yield* MailService.MailService;
      const actor = yield* agentActor;
      const result = yield* failure(
        action === "propose_settle"
          ? mail.propose({ threadIds, reason: reason ?? "fyi" }, actor)
          : mail.act({ threadIds: [...threadIds], action: { type: "unsettle" } }, actor),
      );
      return { changed: result.actionIds.length };
    }),
  ),
});
