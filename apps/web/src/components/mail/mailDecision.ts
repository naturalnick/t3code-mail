import type { MailThreadRow } from "@t3tools/contracts";

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
