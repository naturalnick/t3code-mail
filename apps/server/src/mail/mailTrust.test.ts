import { describe, expect, it } from "vite-plus/test";

import {
  decide,
  emptyRecord,
  recordApproval,
  recordRejection,
  reverseTrust,
  type TrustRecord,
} from "./mailTrust.ts";

const settle = { decision: "settle", reason: "fyi", confidence: 0.9 } as const;
const sender = (patch: Partial<TrustRecord> = {}): TrustRecord => ({
  ...emptyRecord("sender:news@acme.dev", "sender"),
  ...patch,
});
const rule = { reason: "receipt" } as const;
const base = { verdict: settle, sender: null, rule: null, conditional: null };

describe("settle decisions", () => {
  it("never settles on approvals alone", () => {
    let record = sender();
    for (let index = 0; index < 10; index += 1) record = recordApproval(record, { reason: "fyi" });
    expect(record).toMatchObject({ approvals: 10 });
    expect(decide({ ...base, sender: record })).toMatchObject({ type: "suggest", reason: "fyi" });
  });

  it.each([
    {
      name: "suggests when no rule applies",
      input: {},
      expected: { type: "suggest", reason: "fyi" },
    },
    {
      name: "settles with an exact settle rule",
      input: { rule },
      expected: { type: "auto_settle", reason: "receipt" },
    },
    {
      name: "settles when the model says a conditional rule applies",
      input: { conditional: rule },
      expected: { type: "auto_settle", reason: "receipt" },
    },
    {
      name: "only suggests a conditional rule's settle on low confidence",
      input: { conditional: rule, verdict: { ...settle, confidence: 0.4 } },
      expected: { type: "suggest" },
    },
    {
      name: "keeps when the model keeps, even inside a conditional rule",
      input: { conditional: rule, verdict: { ...settle, decision: "keep" } },
      expected: { type: "keep" },
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
