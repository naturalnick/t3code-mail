import { describe, expect, it } from "vite-plus/test";

import {
  canSkipModel,
  decide,
  emptyRecord,
  recordApproval,
  recordRejection,
  setLevel,
  type TrustRecord,
} from "./mailTrust.ts";

const settle = { decision: "settle", reason: "fyi", confidence: 0.9 } as const;
const sender = (patch: Partial<TrustRecord> = {}): TrustRecord => ({
  ...emptyRecord("sender:news@acme.dev", "sender"),
  ...patch,
});
const approve = (record: TrustRecord, times: number, threshold = 3) => {
  let next = record;
  for (let index = 0; index < times; index += 1) {
    next = recordApproval(next, { threshold, reason: "fyi", bulk: true });
  }
  return next;
};

describe("trust ramp", () => {
  it("graduates a sender after N consecutive approvals, not before", () => {
    expect(approve(sender(), 2).trust).toBe("suggest");
    const graduated = approve(sender(), 3);
    expect(graduated.trust).toBe("auto");
    expect(graduated.bulk).toBe(true);
    expect(approve(sender(), 4, 5).trust).toBe("suggest");
    expect(approve(sender(), 1, 1).trust).toBe("auto");
  });

  it("restarts the streak and demotes on a rejection", () => {
    const demoted = recordRejection(approve(sender(), 3));
    expect(demoted).toMatchObject({ trust: "suggest", streak: 0, rejections: 1 });
    expect(approve(demoted, 2).trust).toBe("suggest");
    expect(approve(demoted, 3).trust).toBe("auto");
  });

  it("keeps never-show through a rejection", () => {
    expect(recordRejection(setLevel(sender(), "never")).trust).toBe("never");
  });

  it.each([
    {
      name: "suggests for an unknown sender",
      input: { sender: null, guardrail: null },
      expected: { type: "suggest", reason: "fyi" },
    },
    {
      name: "auto-settles a graduated sender",
      input: { sender: sender({ trust: "auto" }), guardrail: null },
      expected: { type: "auto_settle", via: "sender" },
    },
    {
      name: "asks first on a guardrail even for a graduated sender",
      input: { sender: sender({ trust: "auto" }), guardrail: "money" },
      expected: { type: "suggest" },
    },
    {
      name: "lets an explicit promotion through a guardrail",
      input: { sender: sender({ trust: "auto", explicit: true }), guardrail: "money" },
      expected: { type: "auto_settle", via: "sender" },
    },
    {
      name: "settles never-show senders as noise",
      input: { sender: sender({ trust: "never" }), guardrail: "security" },
      expected: { type: "auto_settle", reason: "noise", via: "never_show" },
    },
  ] as const)("$name", ({ input, expected }) => {
    expect(decide({ verdict: settle, category: null, rule: null, ...input })).toMatchObject(
      expected,
    );
  });

  it("suggests on low confidence even for a trusted sender", () => {
    expect(
      decide({
        verdict: { ...settle, confidence: 0.4 },
        guardrail: null,
        sender: sender({ trust: "auto" }),
        category: null,
        rule: null,
      }).type,
    ).toBe("suggest");
  });

  it("keeps a just-corrected sender in suggest mode inside a trusted category", () => {
    const category = { ...emptyRecord("category:newsletter", "category"), trust: "auto" } as const;
    expect(
      decide({ verdict: settle, guardrail: null, sender: null, category, rule: null }).type,
    ).toBe("auto_settle");
    expect(
      decide({
        verdict: settle,
        guardrail: null,
        sender: recordRejection(sender()),
        category,
        rule: null,
      }).type,
    ).toBe("suggest");
  });

  it("follows the user's rules before the model", () => {
    const base = { verdict: settle, guardrail: null, sender: null, category: null } as const;
    expect(decide({ ...base, rule: { action: "keep", reason: "fyi" } }).type).toBe("keep");
    expect(decide({ ...base, rule: { action: "settle", reason: "receipt" } })).toEqual({
      type: "auto_settle",
      reason: "receipt",
      via: "rule",
    });
  });

  it("skips the model only for mail shaped like what the sender graduated on", () => {
    const graduated = approve(sender(), 3);
    expect(canSkipModel({ sender: graduated, guardrail: null, bulk: true })).toBe(true);
    expect(canSkipModel({ sender: graduated, guardrail: null, bulk: false })).toBe(false);
    expect(canSkipModel({ sender: graduated, guardrail: "urgent", bulk: true })).toBe(false);
  });
});
