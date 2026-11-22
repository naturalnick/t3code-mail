import type {
  MailActionEntry,
  MailAddress,
  MailGuardrail,
  MailSettleReason,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export function senderName(from: MailAddress): string {
  return from.name.trim() || from.address;
}

export function settleReasonLabel(reason: MailSettleReason, resolve: MessageResolver = m): string {
  switch (reason) {
    case "fyi":
      return resolve(msg("FYI", { $context: "email settle reason: read, nothing to do" }));
    case "receipt":
      return resolve(msg("Receipt", { $context: "email settle reason" }));
    case "noise":
      return resolve(msg("Noise", { $context: "email settle reason: unwanted mail" }));
    case "replied":
      return resolve(msg("Replied", { $context: "email settle reason" }));
    case "done":
      return resolve(msg("Done", { $context: "email settle reason" }));
    case "archived":
      return resolve(msg("Archived", { $context: "email settle reason: archived elsewhere" }));
  }
}

/** Why the AI asks before settling this one, even for a trusted sender. */
export function guardrailLabel(guardrail: MailGuardrail, resolve: MessageResolver = m): string {
  switch (guardrail) {
    case "replied_to":
      return resolve(msg("You've written to this sender"));
    case "urgent":
      return resolve(msg("Urgent wording"));
    case "money":
      return resolve(msg("Money or an invoice"));
    case "security":
      return resolve(msg("Account security"));
    case "legal":
      return resolve(msg("Legal"));
  }
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
  const reason =
    action.reason && isSettleReason(action.reason)
      ? settleReasonLabel(action.reason, resolve)
      : null;
  switch (action.kind) {
    case "settle":
    case "approve":
      return reason
        ? resolve(msg("Settled as {reason}", { reason }))
        : resolve(msg("Settled", { $context: "email action log" }));
    case "unsettle":
      return resolve(msg("Moved back to Active"));
    case "reject":
      return resolve(msg("Kept in Active"));
    case "never_show":
      return resolve(msg("Never show this sender"));
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
    case "wait_for_reply":
      return resolve(msg("Waiting for reply"));
    case "send":
      return resolve(msg("Sent a reply"));
    case "trust":
      return resolve(msg("Changed trust"));
    case "nudge":
      return nudgeLabel(action.reason, resolve) ?? resolve(msg("Returned to Active"));
    case "returned":
      return resolve(msg("Returned to Active"));
    case "propose":
      return reason
        ? resolve(msg("Proposed settling as {reason}", { reason }))
        : resolve(msg("Proposed settling"));
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

const SETTLE_REASONS = new Set<string>(["fyi", "receipt", "noise", "replied", "done", "archived"]);

function isSettleReason(value: string): value is MailSettleReason {
  return SETTLE_REASONS.has(value);
}

/** A reply's subject: `Re:` once, never stacked. */
export function replySubject(subject: string): string {
  // oxlint-disable-next-line t3code/no-untranslated-copy -- Re: is the outgoing email's reply prefix.
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

/** Splits a comma or semicolon separated recipient field. */
export function parseRecipients(value: string): ReadonlyArray<string> {
  return value
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
