import type { MailSettleReason } from "@t3tools/contracts";

/**
 * What Mail remembers about how the user answered a sender's or category's suggestions. The
 * model reads it as a fact; it never settles anything by itself.
 */
export interface TrustRecord {
  readonly key: string;
  readonly kind: "sender" | "category";
  readonly reason: MailSettleReason | null;
  readonly approvals: number;
  readonly rejections: number;
}

export interface TrustVerdict {
  readonly decision: "settle" | "keep";
  readonly reason: MailSettleReason | null;
  readonly confidence: number;
}

export interface RuleDecision {
  readonly reason: MailSettleReason;
}

export type TrustDecision =
  | {
      readonly type: "auto_settle";
      readonly reason: MailSettleReason;
    }
  | { readonly type: "suggest"; readonly reason: MailSettleReason; readonly confidence: number }
  | { readonly type: "keep" };

export const LOW_CONFIDENCE = 0.6;

export const senderKey = (address: string) => `sender:${address.toLowerCase()}`;
export const categoryKey = (category: string) => `category:${category}`;

export interface DecideInput {
  readonly verdict: TrustVerdict;
  readonly sender: TrustRecord | null;
  /** A rule without a condition that matched exactly; it skipped the model. */
  readonly rule: RuleDecision | null;
  /** A rule whose plain-language condition the model said this email meets. */
  readonly conditional: RuleDecision | null;
}

/**
 * Only the user's rules settle on their own, and a rule is the user's firm choice, even for
 * money or security mail. The model alone only suggests.
 */
export function decide(input: DecideInput): TrustDecision {
  const { verdict, sender, rule, conditional } = input;
  if (rule) return { type: "auto_settle", reason: rule.reason };
  if (verdict.decision === "keep") return { type: "keep" };
  const reason = conditional?.reason ?? verdict.reason ?? sender?.reason ?? "fyi";
  return conditional && verdict.confidence >= LOW_CONFIDENCE
    ? { type: "auto_settle", reason }
    : { type: "suggest", reason, confidence: verdict.confidence };
}

export function emptyRecord(key: string, kind: TrustRecord["kind"]): TrustRecord {
  return { key, kind, reason: null, approvals: 0, rejections: 0 };
}

export function recordApproval(
  record: TrustRecord,
  input: { readonly reason: MailSettleReason },
): TrustRecord {
  return { ...record, approvals: record.approvals + 1, reason: input.reason };
}

/** A dismissed suggestion or a settle the user took back. */
export function recordRejection(record: TrustRecord): TrustRecord {
  return { ...record, rejections: record.rejections + 1 };
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

export interface TrustUndo {
  readonly effect: TrustFeedback;
  readonly entries: ReadonlyArray<TrustUndoEntry>;
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
