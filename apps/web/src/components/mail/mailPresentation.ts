import type { MailActionEntry, MailAddress } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export function senderName(from: MailAddress): string {
  return from.name.trim() || from.address;
}

/** Nudges arrive as `waiting:N` or `unanswered:N`, so the server never stores translated copy. */
export function nudgeLabel(code: string | null, resolve: MessageResolver = m): string | null {
  const match = code?.match(/^(waiting|unanswered):(\d+)$/);
  if (!match) return null;
  const days = Number(match[2]);
  return match[1] === "waiting"
    ? resolve(msg("{days, plural, one {No reply in # day} other {No reply in # days}}", { days }))
    : resolve(
        msg(
          "{days, plural, one {You haven't replied in # day} other {You haven't replied in # days}}",
          { days },
        ),
      );
}

export function actionLabel(action: MailActionEntry, resolve: MessageResolver = m): string {
  switch (action.kind) {
    case "settle":
    case "approve":
      return resolve(msg("Settled", { $context: "email action log" }));
    case "unsettle":
      return resolve(msg("Moved to inbox"));
    case "reject":
      return resolve(msg("Dismissed suggestion"));
    case "settle_sender":
      return resolve(msg("Always settle from this sender"));
    case "pin":
      return resolve(msg("Pinned", { $context: "email action log" }));
    case "unpin":
      return resolve(msg("Unpinned", { $context: "email action log" }));
    case "snooze":
      return resolve(msg("Snoozed", { $context: "email action log" }));
    case "unsnooze":
      return resolve(msg("Woke from snooze"));
    case "draft":
      if (action.reason === "discard") return resolve(msg("Discard draft"));
      return action.reason === "edit" ? resolve(msg("Edit draft")) : resolve(msg("Left a draft"));
    case "mark_read":
      return resolve(msg("Read"));
    case "mark_unread":
      return resolve(msg("Marked as unread"));
    case "delete":
      return resolve(msg("Moved to Trash"));
    case "wait_for_reply":
      return resolve(msg("Waiting for reply"));
    case "send":
      return action.reason ?? resolve(msg("Sent a reply"));
    case "nudge":
      return nudgeLabel(action.reason, resolve) ?? resolve(msg("Returned to Active"));
    case "returned":
      return resolve(msg("Returned to Active"));
    case "propose":
      return resolve(msg("Suggested settling"));
  }
}

export function actorLabel(action: MailActionEntry, resolve: MessageResolver = m): string {
  switch (action.actor) {
    case "user":
      return resolve(msg("You", { $context: "who acted on an email" }));
    case "ai":
      return resolve(msg("AI", { $context: "who acted on an email" }));
    case "rule":
      return resolve(msg("Rule", { $context: "who acted on an email: a mail rule" }));
    case "agent":
      return action.actorLabel ?? resolve(msg("Agent", { $context: "who acted on an email" }));
    case "mail":
      return resolve(msg("Mail", { $context: "who acted on an email: the app itself" }));
  }
}

/** A reply's subject: `Re:` once, never stacked. */
export function replySubject(subject: string): string {
  // oxlint-disable-next-line t3code/no-untranslated-copy -- Re: is the outgoing email's reply prefix.
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

export function forwardSubject(subject: string): string {
  // oxlint-disable-next-line t3code/no-untranslated-copy -- Fwd: is the outgoing email's forward prefix.
  return /^(fwd?|fw):/i.test(subject.trim()) ? subject : `Fwd: ${subject}`;
}

/** Splits a comma or semicolon separated recipient field. */
export function parseRecipients(value: string): ReadonlyArray<string> {
  return value
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
