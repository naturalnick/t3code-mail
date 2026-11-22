import { matchesRule } from "@t3tools/shared/mailRule";
import type { MailMessage, MailRule, MailThreadRow } from "@t3tools/contracts";

/**
 * Who made the decision the thread currently shows, and the model's reason when it has one. A
 * reason outlives a decision the user has since changed, so it is only returned while it applies.
 */
export function mailDecision(
  thread: MailThreadRow,
): { actor: "ai" | "rule"; why: string | null } | null {
  if (thread.state === "active" && thread.suggestion !== null) {
    return thread.suggestion.byRule
      ? { actor: "rule", why: null }
      : { actor: "ai", why: thread.why };
  }
  if (thread.state === "settled" && thread.settledBy === "rule")
    return { actor: "rule", why: thread.why };
  if (thread.state === "settled" && thread.settledBy === "ai")
    return { actor: "ai", why: thread.why };
  // Kept in Active by the model: its reason explains why the email is still here.
  if (thread.state === "active" && thread.why !== null) return { actor: "ai", why: thread.why };
  return null;
}

export function threadAutoSettleRules(
  rules: readonly MailRule[],
  message: Pick<MailMessage, "from" | "subject" | "listId" | "outgoing"> | null,
  appliedId: string | null,
) {
  const inScope =
    !message || message.outgoing
      ? []
      : rules.filter((rule) =>
          matchesRule(rule, {
            fromAddress: message.from.address,
            subject: message.subject,
            listId: message.listId,
          }),
        );
  const applied =
    inScope.find((rule) => rule.id === appliedId) ?? inScope.find((rule) => !rule.when) ?? null;
  return { inScope, applied };
}
