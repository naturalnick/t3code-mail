import type { MailGuardrail, MailSettleReason, MailTrustLevel } from "@t3tools/contracts";

/**
 * What Mail remembers about how the user answered a sender's or category's suggestions. The
 * model reads it as a fact; it never settles anything by itself. "never" is Never show.
 */
export interface TrustRecord {
  readonly key: string;
  readonly kind: "sender" | "category";
  readonly reason: MailSettleReason | null;
  readonly approvals: number;
  readonly rejections: number;
  readonly trust: MailTrustLevel;
}

export interface TrustVerdict {
  readonly decision: "settle" | "keep";
  readonly reason: MailSettleReason | null;
  readonly confidence: number;
}

export interface RuleDecision {
  readonly action: "settle" | "keep" | "never_show";
  readonly reason: MailSettleReason;
  readonly sensitive: boolean;
}

export type TrustDecision =
  | {
      readonly type: "auto_settle";
      readonly reason: MailSettleReason;
      readonly via: "never_show" | "rule";
    }
  | { readonly type: "suggest"; readonly reason: MailSettleReason; readonly confidence: number }
  | { readonly type: "keep" };

export const LOW_CONFIDENCE = 0.6;

export const senderKey = (address: string) => `sender:${address.toLowerCase()}`;
export const categoryKey = (category: string) => `category:${category}`;

export interface DecideInput {
  readonly verdict: TrustVerdict;
  readonly guardrail: MailGuardrail | null;
  readonly sender: TrustRecord | null;
  /** A rule without a condition that matched exactly; it skipped the model. */
  readonly rule: RuleDecision | null;
  /** A rule whose plain-language condition the model said this email meets. */
  readonly conditional: RuleDecision | null;
}

/** Only the user's rules settle on their own; the model alone only suggests. */
export function decide(input: DecideInput): TrustDecision {
  const { verdict, guardrail, sender, rule, conditional } = input;
  if (sender?.trust === "never" || rule?.action === "never_show") {
    return { type: "auto_settle", reason: "noise", via: "never_show" };
  }
  if (rule?.action === "keep") return { type: "keep" };
  if (rule?.action === "settle") {
    // A broad rule ("settle everything from this domain") still asks about an invoice.
    return guardrail === null || rule.sensitive
      ? { type: "auto_settle", reason: rule.reason, via: "rule" }
      : { type: "suggest", reason: rule.reason, confidence: 1 };
  }
  if (verdict.decision === "keep" || conditional?.action === "keep") return { type: "keep" };
  const reason = conditional?.reason ?? verdict.reason ?? sender?.reason ?? "fyi";
  const suggest: TrustDecision = { type: "suggest", reason, confidence: verdict.confidence };
  if (conditional?.action !== "settle" || verdict.confidence < LOW_CONFIDENCE) return suggest;
  return guardrail === null || conditional.sensitive
    ? { type: "auto_settle", reason, via: "rule" }
    : suggest;
}

export function emptyRecord(key: string, kind: TrustRecord["kind"]): TrustRecord {
  return { key, kind, reason: null, approvals: 0, rejections: 0, trust: "suggest" };
}

export function recordApproval(
  record: TrustRecord,
  input: { readonly reason: MailSettleReason },
): TrustRecord {
  return { ...record, approvals: record.approvals + 1, reason: input.reason };
}

/** A dismissed suggestion or a settle the user took back. It also ends Never show. */
export function recordRejection(record: TrustRecord): TrustRecord {
  return { ...record, rejections: record.rejections + 1, trust: "suggest" };
}

export interface TrustClock {
  readonly revision: number;
  readonly setting: number;
  readonly reset: number;
}

export interface TrustUndoEntry {
  readonly key: string;
  readonly kind: TrustRecord["kind"];
  readonly clock: TrustClock;
}

export type TrustFeedback = "approve" | "reject" | "ai_settle";

export type TrustUndo =
  | { readonly effect: TrustFeedback; readonly entries: ReadonlyArray<TrustUndoEntry> }
  | {
      readonly effect: "level";
      readonly entry: TrustUndoEntry;
      readonly before: Partial<Omit<TrustRecord, "key" | "kind">> | null;
    };

export function previousTrustFields(before: TrustRecord | null, after: TrustRecord | null) {
  if (!before) return null;
  const { key: _key, kind: _kind, ...fields } = before;
  if (!after) return fields;
  return Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => after[key as keyof typeof fields] !== value),
  );
}

/** Undo is fresh feedback. Only votes from the same reset generation still count. */
export function reverseTrust(
  effect: TrustFeedback,
  current: TrustRecord,
  previous: TrustClock,
  latest: TrustClock,
): TrustRecord {
  if (previous.reset !== latest.reset) return current;
  const approvals = Math.max(0, current.approvals - (effect === "approve" ? 1 : 0));
  const rejections =
    Math.max(0, current.rejections - (effect === "reject" ? 1 : 0)) +
    (effect === "ai_settle" ? 1 : 0);
  return { ...current, approvals, rejections };
}

export function setLevel(record: TrustRecord, level: MailTrustLevel | "reset"): TrustRecord {
  if (level === "reset") return emptyRecord(record.key, record.kind);
  return { ...record, trust: level };
}
