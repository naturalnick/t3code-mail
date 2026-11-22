import { describe, expect, it } from "vite-plus/test";

import {
  decide,
  emptyRecord,
  recordApproval,
  recordRejection,
  reverseTrust,
  setLevel,
  type TrustRecord,
} from "./mailTrust.ts";

const settle = { decision: "settle", reason: "fyi", confidence: 0.9 } as const;
const sender = (patch: Partial<TrustRecord> = {}): TrustRecord => ({
  ...emptyRecord("sender:news@acme.dev", "sender"),
  ...patch,
});
const rule = (patch: { action?: "settle" | "keep"; sensitive?: boolean } = {}) =>
  ({
    action: patch.action ?? "settle",
    reason: "receipt",
    sensitive: patch.sensitive ?? false,
  }) as const;
const base = { verdict: settle, guardrail: null, sender: null, rule: null, conditional: null };

describe("settle decisions", () => {
  it("never settles on approvals alone", () => {
    let record = sender();
    for (let index = 0; index < 10; index += 1) record = recordApproval(record, { reason: "fyi" });
    expect(record).toMatchObject({ approvals: 10, trust: "suggest" });
    expect(decide({ ...base, sender: record })).toMatchObject({ type: "suggest", reason: "fyi" });
  });

  it("ends Never show when the user keeps a sender's mail", () => {
    expect(recordRejection(setLevel(sender(), "never")).trust).toBe("suggest");
  });

  it.each([
    {
      name: "suggests when no rule applies",
      input: {},
      expected: { type: "suggest", reason: "fyi" },
    },
    {
      name: "settles never-show senders as noise, guardrail or not",
      input: { sender: sender({ trust: "never" }), guardrail: "security" },
      expected: { type: "auto_settle", reason: "noise", via: "never_show" },
    },
    {
      name: "follows an exact keep rule",
      input: { rule: rule({ action: "keep" }) },
      expected: { type: "keep" },
    },
    {
      name: "settles with an exact settle rule",
      input: { rule: rule() },
      expected: { type: "auto_settle", reason: "receipt", via: "rule" },
    },
    {
      name: "asks first when an exact rule meets an invoice",
      input: { rule: rule(), guardrail: "money" },
      expected: { type: "suggest" },
    },
    {
      name: "lets a sensitive exact rule through a guardrail",
      input: { rule: rule({ sensitive: true }), guardrail: "money" },
      expected: { type: "auto_settle", via: "rule" },
    },
    {
      name: "settles when the model says a conditional rule applies",
      input: { conditional: rule() },
      expected: { type: "auto_settle", reason: "receipt", via: "rule" },
    },
    {
      name: "only suggests a conditional rule's settle on low confidence",
      input: { conditional: rule(), verdict: { ...settle, confidence: 0.4 } },
      expected: { type: "suggest" },
    },
    {
      name: "keeps when the model keeps, even inside a conditional rule",
      input: { conditional: rule(), verdict: { ...settle, decision: "keep" } },
      expected: { type: "keep" },
    },
    {
      name: "keeps on a conditional keep rule",
      input: { conditional: rule({ action: "keep" }) },
      expected: { type: "keep" },
    },
    {
      name: "asks first when a conditional rule meets a guardrail",
      input: { conditional: rule(), guardrail: "security" },
      expected: { type: "suggest" },
    },
    {
      name: "lets a sensitive conditional rule through a guardrail",
      input: { conditional: rule({ sensitive: true }), guardrail: "security" },
      expected: { type: "auto_settle", via: "rule" },
    },
  ] as const)("$name", ({ input, expected }) => {
    expect(decide({ ...base, ...input })).toMatchObject(expected);
  });

  it("undoes one vote and keeps what happened after it", () => {
    const clock = { revision: 3, setting: 0, reset: 0 };
    const voted = recordApproval(recordRejection(sender()), { reason: "fyi" });
    expect(reverseTrust("approve", voted, clock, clock)).toMatchObject({
      approvals: 0,
      rejections: 1,
    });
    expect(reverseTrust("reject", voted, clock, clock)).toMatchObject({
      approvals: 1,
      rejections: 0,
    });
    expect(reverseTrust("ai_settle", voted, clock, clock)).toMatchObject({ rejections: 2 });
    expect(reverseTrust("approve", voted, clock, { ...clock, reset: 1 })).toEqual(voted);
  });
});
