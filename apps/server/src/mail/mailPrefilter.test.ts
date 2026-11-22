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
      name: "a person is a person with no guardrail",
      input: {},
      expected: { category: "person", guardrail: null },
    },
    {
      name: "a sign-in code is not a security alert",
      input: {
        fromAddress: "no-reply@accounts.example.com",
        subject: "Your verification code",
        text: "Your verification code is 482913.",
      },
      expected: { category: "otp", guardrail: null },
    },
    {
      name: "a security alert is guarded and goes to L1",
      input: {
        fromAddress: "no-reply@accounts.example.com",
        subject: "Security alert",
        text: "New sign-in on a Mac. If this wasn't you, reset your password.",
      },
      expected: { category: "security", guardrail: "security" },
    },
    {
      name: "an invoice is guarded as money",
      input: {
        fromAddress: "billing@vendor.example",
        subject: "Invoice 1042",
        text: "Amount due: $420 by Friday.",
      },
      expected: { category: "invoice", guardrail: "money" },
    },
    {
      name: "a bill notice without money words is still guarded as money",
      input: {
        fromAddress: "no-reply@power.example",
        subject: "Your November statement",
        text: "Your bill is ready to view online.",
      },
      expected: { category: "invoice", guardrail: "money" },
    },
    {
      name: "list mail with a sale is a promotion",
      input: {
        fromAddress: "deals@shop.example",
        subject: "40% off this weekend",
        text: "Shop now, limited time.",
        listUnsubscribe: true,
      },
      expected: { category: "promotion" },
    },
    {
      name: "urgent wording guards a newsletter",
      input: {
        fromAddress: "news@paper.example",
        subject: "Morning briefing",
        text: "Action required: confirm your subscription today.",
        listId: "<briefing.paper.example>",
      },
      expected: { category: "newsletter", guardrail: "urgent" },
    },
    {
      name: "someone the user has written to is always guarded",
      input: { subject: "Order confirmation", text: "Thanks for your order", repliedTo: true },
      expected: { guardrail: "replied_to" },
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
        reason: "fyi",
      },
      {
        id: "acme",
        enabled: true,
        match: { domain: "@acme.dev" },
        reason: "receipt",
      },
    ];
    expect(prefilter({ ...base, fromAddress: "billing@mail.acme.dev" }, rules).rule).toMatchObject({
      id: "acme",
      reason: "receipt",
    });
    expect(prefilter({ ...base, fromAddress: "x@notacme.dev" }, rules).rule).toBeNull();
  });

  it("leaves rules with a condition to the model, in scope only, unless an exact rule decides", () => {
    const shipping: MailRule = {
      id: "shipping",
      enabled: true,
      match: { domain: "shop.dev" },
      when: "Shipping updates. Keep delivery confirmations.",
      reason: "fyi",
    };
    const anywhere: MailRule = {
      id: "promos",
      enabled: true,
      match: {},
      when: "Promotions",
      reason: "noise",
    };
    const shop = { ...base, fromAddress: "orders@shop.dev" };
    expect(prefilter(shop, [shipping, anywhere])).toMatchObject({
      rule: null,
      conditional: [
        { id: "shipping", when: shipping.when },
        { id: "promos", when: "Promotions" },
      ],
    });
    expect(prefilter({ ...base, fromAddress: "x@other.dev" }, [shipping]).conditional).toEqual([]);
    const { when: _when, ...unconditional } = shipping;
    const exact: MailRule = { ...unconditional, id: "all-shop" };
    expect(prefilter(shop, [shipping, exact])).toMatchObject({
      rule: { id: "all-shop" },
      conditional: [],
    });
    // A rule needs a scope or a condition.
    expect(prefilter(shop, [{ ...exact, match: {} }]).rule).toBeNull();
  });
});
