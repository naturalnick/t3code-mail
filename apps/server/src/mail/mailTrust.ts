import type { MailGuardrail, MailSettleReason, MailTrustLevel } from "@t3tools/contracts";

/** The stored settle-memory record for one sender or category key. */
export interface TrustRecord {
  readonly key: string;
  readonly kind: "sender" | "category";
  readonly reason: MailSettleReason | null;
  readonly approvals: number;
  readonly rejections: number;
  readonly streak: number;
  readonly trust: MailTrustLevel;
  readonly explicit: boolean;
  /** The bulk shape (list mail or not) of the mail the sender graduated on. */
  readonly bulk: boolean | null;
}

export interface TrustVerdict {
  readonly decision: "settle" | "keep";
  readonly reason: MailSettleReason | null;
  readonly confidence: number;
}

export type TrustDecision =
  | {
      readonly type: "auto_settle";
      readonly reason: MailSettleReason;
      readonly via: "sender" | "category" | "never_show" | "rule";
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
  readonly category: TrustRecord | null;
  readonly rule: {
    readonly action: "settle" | "keep" | "never_show";
    readonly reason: MailSettleReason;
  } | null;
}

/** Trust is earned per sender and category; guardrails and low confidence always ask first. */
export function decide(input: DecideInput): TrustDecision {
  const { verdict, guardrail, sender, category, rule } = input;
  if (sender?.trust === "never" || rule?.action === "never_show") {
    return { type: "auto_settle", reason: "noise", via: "never_show" };
  }
  if (rule?.action === "keep") return { type: "keep" };
  const explicitlyTrusted = sender?.trust === "auto" && sender.explicit;
  if (rule?.action === "settle") {
    // A broad rule ("settle everything from this domain") still asks about an invoice.
    return guardrail === null || explicitlyTrusted
      ? { type: "auto_settle", reason: rule.reason, via: "rule" }
      : { type: "suggest", reason: rule.reason, confidence: 1 };
  }
  if (verdict.decision === "keep") return { type: "keep" };
  const reason = verdict.reason ?? sender?.reason ?? category?.reason ?? "fyi";
  const suggest: TrustDecision = { type: "suggest", reason, confidence: verdict.confidence };
  if (verdict.confidence < LOW_CONFIDENCE) return suggest;
  if (guardrail !== null) {
    return explicitlyTrusted ? { type: "auto_settle", reason, via: "sender" } : suggest;
  }
  if (sender?.trust === "auto") return { type: "auto_settle", reason, via: "sender" };
  // A sender the user just corrected stays in suggest mode even inside a trusted category.
  const senderDemoted = sender !== null && sender.streak === 0 && sender.rejections > 0;
  if (category?.trust === "auto" && !senderDemoted) {
    return { type: "auto_settle", reason, via: "category" };
  }
  return suggest;
}

export function emptyRecord(key: string, kind: TrustRecord["kind"]): TrustRecord {
  return {
    key,
    kind,
    reason: null,
    approvals: 0,
    rejections: 0,
    streak: 0,
    trust: "suggest",
    explicit: false,
    bulk: null,
  };
}

/** One approved settle. N in a row with no rejection graduates the key. */
export function recordApproval(
  record: TrustRecord,
  input: { readonly threshold: number; readonly reason: MailSettleReason; readonly bulk: boolean },
): TrustRecord {
  const streak = record.streak + 1;
  const graduates = record.trust === "suggest" && streak >= input.threshold;
  return {
    ...record,
    approvals: record.approvals + 1,
    streak,
    reason: input.reason,
    trust: graduates ? "auto" : record.trust,
    bulk: graduates ? input.bulk : record.bulk,
  };
}

/** An undo or "keep in Active" drops the key back to suggest mode and restarts its count. */
export function recordRejection(record: TrustRecord): TrustRecord {
  return {
    ...record,
    rejections: record.rejections + 1,
    streak: 0,
    trust: record.trust === "never" ? "never" : "suggest",
    explicit: false,
  };
}

/** What an action did to one key, so undoing it reverses only that and keeps later changes. */
export interface TrustUndoEntry {
  readonly key: string;
  readonly kind: TrustRecord["kind"];
  readonly before: TrustRecord;
  /** Null when the action deleted the record. */
  readonly after: TrustRecord | null;
}

export type TrustEffect = "approve" | "reject" | "level" | "ai_settle";

export interface TrustUndo {
  readonly effect: TrustEffect;
  readonly entries: ReadonlyArray<TrustUndoEntry>;
}

/** Null deletes the record. */
export function reverseTrust(
  effect: TrustEffect,
  current: TrustRecord | null,
  entry: TrustUndoEntry,
): TrustRecord | null {
  const record = current ?? emptyRecord(entry.key, entry.kind);
  switch (effect) {
    case "ai_settle":
      // Undoing an AI settle is a correction, like "keep in Active".
      return recordRejection(record);
    case "approve": {
      const graduatedHere = entry.before.trust === "suggest" && entry.after?.trust === "auto";
      return {
        ...record,
        approvals: Math.max(0, record.approvals - 1),
        streak: Math.max(0, record.streak - 1),
        trust:
          graduatedHere && record.trust === "auto" && !record.explicit ? "suggest" : record.trust,
      };
    }
    case "reject": {
      const untouched = !record.explicit && record.trust === entry.after?.trust;
      return {
        ...record,
        rejections: Math.max(0, record.rejections - 1),
        streak: record.streak + entry.before.streak,
        ...(untouched ? { trust: entry.before.trust, explicit: entry.before.explicit } : {}),
      };
    }
    case "level": {
      const untouched =
        current === null
          ? entry.after === null
          : entry.after !== null &&
            current.trust === entry.after.trust &&
            current.explicit === entry.after.explicit;
      if (!untouched) return current;
      if (current === null) return entry.before;
      return {
        ...current,
        trust: entry.before.trust,
        explicit: entry.before.explicit,
        streak: entry.before.streak,
        reason: entry.before.reason ?? current.reason,
      };
    }
  }
}

export function setLevel(record: TrustRecord, level: MailTrustLevel | "reset"): TrustRecord {
  if (level === "reset") return emptyRecord(record.key, record.kind);
  return {
    ...record,
    trust: level,
    explicit: true,
    streak: level === "suggest" ? 0 : record.streak,
  };
}

/**
 * A graduated sender can skip the model only for mail shaped like what it graduated on.
 * Anything unusual goes back through L1 and its confidence check.
 */
export function canSkipModel(input: {
  readonly sender: TrustRecord | null;
  readonly guardrail: MailGuardrail | null;
  readonly bulk: boolean;
}): boolean {
  const { sender, guardrail, bulk } = input;
  if (sender === null || guardrail !== null) return false;
  if (sender.trust === "never") return true;
  return sender.trust === "auto" && sender.bulk === bulk;
}
