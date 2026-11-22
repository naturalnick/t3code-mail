import type { MailRule } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { prefilter, type PrefilterInput } from "./mailPrefilter.ts";

const base: PrefilterInput = {
  fromAddress: "sam@example.org",
  fromName: "Sam",
  subject: "Lunch",
  text: "Are you around on Thursday?",
  listUnsubscribe: false,
  listId: null,
  precedence: null,
  autoSubmitted: null,
  hasCalendarInvite: false,
  repliedTo: false,
  ccCount: 0,
  ccOnly: false,
};

describe("prefilter", () => {
  it.each([
    {
      name: "a person goes to L1 without a verdict",
      input: {},
      expected: { category: "person", guardrail: null, verdict: null },
    },
    {
      name: "a sign-in code settles as fyi without tripping the security guardrail",
      input: {
        fromAddress: "no-reply@accounts.example.com",
        subject: "Your verification code",
        text: "Your verification code is 482913.",
      },
      expected: { category: "otp", guardrail: null, verdict: { reason: "fyi" } },
    },
    {
      name: "a security alert is guarded and goes to L1",
      input: {
        fromAddress: "no-reply@accounts.example.com",
        subject: "Security alert",
        text: "New sign-in on a Mac. If this wasn't you, reset your password.",
      },
      expected: { category: "security", guardrail: "security", verdict: null },
    },
    {
      name: "an invoice is guarded as money",
      input: {
        fromAddress: "billing@vendor.example",
        subject: "Invoice 1042",
        text: "Amount due: $420 by Friday.",
      },
      expected: { category: "invoice", guardrail: "money", verdict: null },
    },
    {
      name: "list mail with a sale is a noise promotion",
      input: {
        fromAddress: "deals@shop.example",
        subject: "40% off this weekend",
        text: "Shop now, limited time.",
        listUnsubscribe: true,
      },
      expected: { category: "promotion", verdict: { reason: "noise" } },
    },
    {
      name: "a guardrail suppresses the category verdict",
      input: {
        fromAddress: "news@paper.example",
        subject: "Morning briefing",
        text: "Action required: confirm your subscription today.",
        listId: "<briefing.paper.example>",
      },
      expected: { category: "newsletter", guardrail: "urgent", verdict: null },
    },
    {
      name: "someone the user has written to is always guarded",
      input: { subject: "Order confirmation", text: "Thanks for your order", repliedTo: true },
      expected: { guardrail: "replied_to", verdict: null },
    },
  ] as const)("$name", ({ input, expected }) => {
    expect(prefilter({ ...base, ...input }, [])).toMatchObject(expected);
  });

  it("applies the first enabled rule that matches by domain, subdomains included", () => {
    const rules: ReadonlyArray<MailRule> = [
      {
        id: "off",
        enabled: false,
        match: { domain: "acme.dev" },
        action: "keep",
        reason: "fyi",
      },
      {
        id: "acme",
        enabled: true,
        match: { domain: "@acme.dev" },
        action: "settle",
        reason: "receipt",
      },
    ];
    expect(prefilter({ ...base, fromAddress: "billing@mail.acme.dev" }, rules).rule).toEqual({
      id: "acme",
      action: "settle",
      reason: "receipt",
    });
    expect(prefilter({ ...base, fromAddress: "x@notacme.dev" }, rules).rule).toBeNull();
  });
});
