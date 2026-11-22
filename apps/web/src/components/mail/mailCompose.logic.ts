import type { MailAddress, MailDraft, MailMessage } from "@t3tools/contracts";

import { forwardSubject, replySubject } from "./mailPresentation";

/** What the user chose; a saved draft stores only reply or forward, plus its recipients. */
export type ComposeMode = "reply" | "replyAll" | "forward";

/** Replies answer the newest message someone else sent, so your own forward is never the default. */
export function defaultReplyTarget(messages: ReadonlyArray<MailMessage>): MailMessage | null {
  return messages.findLast((message) => !message.outgoing) ?? messages.at(-1) ?? null;
}

const lower = (address: string) => address.trim().toLowerCase();

function pick(entries: ReadonlyArray<MailAddress>, skip: Set<string>): ReadonlyArray<string> {
  return entries.flatMap((entry) => {
    const key = lower(entry.address);
    if (!key || skip.has(key)) return [];
    skip.add(key);
    return [entry.address];
  });
}

/** The people a reply would reach besides you, so Reply all only shows when it differs. */
export function hasOtherRecipients(message: MailMessage, mine: ReadonlyArray<string>): boolean {
  const reply = composeRecipients("reply", message, mine);
  const all = composeRecipients("replyAll", message, mine);
  return all.to.length + all.cc.length > reply.to.length + reply.cc.length;
}

/**
 * Default To and Cc. Reply goes to Reply-To (else the sender); Reply all adds everyone else on the
 * message. On your own message, a reply goes back to the people you wrote to. You are never added.
 */
export function composeRecipients(
  mode: ComposeMode,
  message: MailMessage,
  mine: ReadonlyArray<string>,
): { readonly to: ReadonlyArray<string>; readonly cc: ReadonlyArray<string> } {
  if (mode === "forward") return { to: [], cc: [] };
  const skip = new Set(mine.map(lower));
  if (message.outgoing) {
    const to = pick(message.to, skip);
    return { to, cc: mode === "replyAll" ? pick(message.cc, skip) : [] };
  }
  const to = pick(message.replyTo.length > 0 ? message.replyTo : [message.from], skip);
  if (mode !== "replyAll") return { to, cc: [] };
  return { to, cc: pick([message.from, ...message.to, ...message.cc], skip) };
}

export function composeSubject(mode: ComposeMode, subject: string): string {
  return mode === "forward" ? forwardSubject(subject) : replySubject(subject);
}

/** How a reopened draft reads: a reply that reaches more than one person was a Reply all. */
export function draftMode(draft: MailDraft): ComposeMode {
  if (draft.mode === "forward") return "forward";
  return draft.to.length + draft.cc.length > 1 ? "replyAll" : "reply";
}

export function draftTarget(
  draft: MailDraft,
  messages: ReadonlyArray<MailMessage>,
): MailMessage | null {
  return (
    messages.find((message) => message.id === draft.targetMessageId) ?? defaultReplyTarget(messages)
  );
}

export function isMine(address: string, mine: ReadonlyArray<string>): boolean {
  const key = lower(address);
  return mine.some((entry) => lower(entry) === key);
}

/** An outgoing message whose subject reads as a forward. */
export function isForward(message: MailMessage): boolean {
  return message.outgoing && /^\s*(fwd?|fw)\s*:/i.test(message.subject);
}

/** One line for a collapsed message. */
export function messageSnippet(message: MailMessage): string {
  return (message.text ?? message.fullText ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}
