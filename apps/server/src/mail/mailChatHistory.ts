import {
  CommandId,
  EventId,
  MessageId,
  type MailGuardrail,
  type MailThreadId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import type { TrustDecision } from "./mailTrust.ts";
import type { MailStore, ThreadVerdict } from "./MailStore.ts";

const reviewReason: Record<MailGuardrail, string> = {
  security: "This concerns account security.",
  legal: "This concerns a legal matter.",
  money: "This concerns a payment.",
  replied_to: "You have replied to this sender before.",
  urgent: "This was flagged as urgent.",
};

export function triageOutcome(decision: TrustDecision, guardrail: MailGuardrail | null) {
  if (decision.type === "keep")
    return guardrail ? `Kept in Active. ${reviewReason[guardrail]}` : "Kept in Active.";
  const reason = decision.reason === "fyi" ? "FYI" : decision.reason;
  if (decision.type === "suggest")
    return `Suggested settling as ${reason}. ${guardrail ? reviewReason[guardrail] + " " : ""}Left in Active for your review.`;
  const via = {
    sender: "your sender preference",
    category: "your category preference",
    rule: "your mail rule",
    never_show: "your Never Show preference",
  }[decision.via];
  return `Settled as ${reason} using ${via}.`;
}

export function triageText(
  source: ThreadVerdict["source"],
  model: string | undefined,
  line: string,
  outcome: string,
) {
  const author =
    source === "rule"
      ? "Mail rule"
      : source === "memory"
        ? "Sender preference"
        : (model ?? "Mail model");
  // Chat renders Markdown. A sender's subject or excerpt must never embed a remote image.
  const plain = (value: string) =>
    value
      .replace(/\s+/gu, " ")
      .trim()
      .replace(/[\\`*_{}[\]()<>#+.!|~&-]/gu, "\\$&");
  return `${plain(author)} · ${outcome}\n\n${plain(line)}`.trim();
}

export const publishTriageNotes = Effect.fn("Mail.publishTriageNotes")(function* (
  store: MailStore["Service"],
  sink: EventSinkV2["Service"],
  mailId: MailThreadId,
  threadId: ThreadId,
) {
  while (true) {
    const notes = yield* store.unpublishedTriageNotes(mailId, threadId);
    for (const note of notes) {
      const key = `mail:triage:${threadId}:${note.id}`;
      const at = DateTime.makeUnsafe(note.at);
      const messageId = MessageId.make(key);
      const common = {
        threadId,
        runId: null,
        nodeId: null,
        text: note.text,
        streaming: false,
        updatedAt: at,
      };
      // Mail and chat live in separate databases. Replaying after a lost acknowledgement is safe.
      yield* sink.commitCommand({
        commandId: CommandId.make(key),
        threadId,
        commandType: "mail.triage",
        acceptedAt: at,
        effects: [],
        events: [
          {
            id: EventId.make(key),
            type: "message.updated",
            threadId,
            occurredAt: at,
            payload: {
              ...common,
              id: messageId,
              role: "assistant",
              createdBy: "agent",
              creationSource: "server",
              attachments: [],
              createdAt: at,
            },
          },
          {
            id: EventId.make(`${key}:item`),
            type: "turn-item.updated",
            threadId,
            occurredAt: at,
            payload: {
              ...common,
              id: TurnItemId.make(key),
              type: "assistant_message",
              messageId,
              phase: "final_answer",
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "completed",
              title: null,
              startedAt: at,
              completedAt: at,
            },
          },
        ],
      });
      yield* store.markTriageNotePublished(note.id, threadId);
    }
    if (notes.length < 50) return;
  }
});
