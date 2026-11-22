import type {
  MailCategory,
  MailGuardrail,
  MailRule,
  MailRuleAction,
  MailSettleReason,
} from "@t3tools/contracts";

import { domainOf } from "./mailText.ts";

export interface PrefilterInput {
  readonly fromAddress: string;
  readonly fromName: string;
  readonly subject: string;
  /** Cleaned text of the newest message. */
  readonly text: string;
  readonly listUnsubscribe: boolean;
  readonly listId: string | null;
  readonly precedence: string | null;
  readonly autoSubmitted: string | null;
  readonly hasCalendarInvite: boolean;
  /** The sender is someone the user has written to. */
  readonly repliedTo: boolean;
  readonly ccCount: number;
  /** The user is only on Cc, not To. */
  readonly ccOnly: boolean;
}

export interface PrefilterResult {
  readonly category: MailCategory;
  readonly guardrail: MailGuardrail | null;
  readonly bulk: boolean;
  readonly rule: {
    readonly id: string;
    readonly action: MailRuleAction;
    readonly reason: MailSettleReason;
  } | null;
}

const OTP =
  /\b(verification|security|login|sign[- ]in|one[- ]time|confirmation|access|auth(entication)?) code\b|\bOTP\b|\bpasscode\b|\byour code is\b/i;
const OTP_DIGITS = /\b\d{4,8}\b/;
const DELIVERY =
  /\b(has shipped|was shipped|out for delivery|was delivered|has been delivered|tracking (number|info)|your (package|parcel|shipment)|arriving (today|tomorrow))\b/i;
const RECEIPT =
  /\b(receipt|order confirm(ation|ed)|your order\b|payment (received|confirmation|successful)|thanks for your (order|purchase)|purchase confirmation|we('ve| have) received your payment)\b/i;
const INVOICE =
  /\b(invoice|bill is (ready|due|available)|payment (is )?due|amount due|past due|overdue|statement is (ready|available)|balance due|pay by)\b/i;
const SECURITY =
  /\b(security alert|new (sign[- ]in|login|device)|sign[- ]in attempt|password (was )?(changed|reset)|reset your password|suspicious|unusual (activity|sign)|2-step|two[- ]factor|account (locked|suspended|compromised)|verify your (identity|account))\b/i;
const LEGAL =
  /\b(lawsuit|subpoena|legal (notice|action|hold)|attorney|court (date|order)|cease and desist|summons|settlement agreement|data subject request)\b/i;
const URGENT =
  /\b(urgent|asap|as soon as possible|immediately|action required|time[- ]sensitive|final (notice|reminder)|deadline (is )?(today|tomorrow)|by end of (day|today)|respond by)\b/i;
const MONEY =
  /\b(invoice|payment (is )?due|amount due|past due|overdue|wire transfer|bank transfer|remittance|pay(ment)? (now|today)|outstanding balance|refund (request|due))\b/i;
const PROMO =
  /\b(\d{1,2}% off|sale\b|deal(s)? (of|for)|limited time|shop now|free shipping|exclusive offer|coupon|promo code|last chance|black friday|cyber monday)\b/i;
const CALENDAR =
  /^(invitation|updated invitation|canceled event|cancelled event|accepted|declined|tentative)(:| -)/i;
const SOCIAL_DOMAINS = new Set([
  "facebookmail.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "instagram.com",
  "pinterest.com",
  "reddit.com",
  "redditmail.com",
  "tiktok.com",
]);
const NO_REPLY =
  /^(no-?reply|do-?not-?reply|notifications?|alerts?|mailer|bounce|updates?|news)([+.-]|@)/i;

export function categoryGuardrail(category: string): MailGuardrail | null {
  if (category === "invoice") return "money";
  if (category === "legal" || category === "security") return category;
  return null;
}

function guardrailFor(input: PrefilterInput, category: MailCategory): MailGuardrail | null {
  const text = `${input.subject}\n${input.text}`;
  if (input.repliedTo) return "replied_to";
  if (LEGAL.test(text)) return "legal";
  const guardrail = categoryGuardrail(category);
  if (guardrail !== null) return guardrail;
  // A sign-in code is routine; an alert about the account is not.
  if (category !== "otp" && SECURITY.test(text)) return "security";
  if (MONEY.test(text)) return "money";
  if (URGENT.test(text)) return "urgent";
  return null;
}

function categorize(input: PrefilterInput, bulk: boolean): MailCategory {
  const subjectAndText = `${input.subject}\n${input.text.slice(0, 2_000)}`;
  const domain = domainOf(input.fromAddress);
  if (input.hasCalendarInvite || CALENDAR.test(input.subject)) return "calendar";
  if (OTP.test(subjectAndText) && OTP_DIGITS.test(subjectAndText)) return "otp";
  if (SECURITY.test(subjectAndText) && !bulk) return "security";
  if (LEGAL.test(subjectAndText)) return "legal";
  if (INVOICE.test(subjectAndText)) return "invoice";
  if (RECEIPT.test(subjectAndText)) return "receipt";
  if (DELIVERY.test(subjectAndText)) return "delivery";
  if ([...SOCIAL_DOMAINS].some((social) => domain === social || domain.endsWith(`.${social}`))) {
    return "social";
  }
  if (bulk) return PROMO.test(subjectAndText) ? "promotion" : "newsletter";
  if (NO_REPLY.test(input.fromAddress) || input.autoSubmitted !== null) return "notification";
  return "person";
}

export function matchesRule(
  rule: MailRule,
  input: Pick<PrefilterInput, "fromAddress" | "subject" | "listId">,
): boolean {
  if (!rule.enabled) return false;
  const { from, domain, subjectContains, listId } = rule.match;
  if (!from && !domain && !subjectContains && !listId) return false;
  const address = input.fromAddress.toLowerCase();
  if (from && !address.includes(from.toLowerCase())) return false;
  if (domain) {
    const wanted = domain.toLowerCase().replace(/^@/, "");
    const actual = domainOf(address);
    if (actual !== wanted && !actual.endsWith(`.${wanted}`)) return false;
  }
  if (subjectContains && !input.subject.toLowerCase().includes(subjectContains.toLowerCase())) {
    return false;
  }
  if (listId && !(input.listId ?? "").toLowerCase().includes(listId.toLowerCase())) return false;
  return true;
}

export function prefilter(input: PrefilterInput, rules: ReadonlyArray<MailRule>): PrefilterResult {
  const precedence = input.precedence?.toLowerCase() ?? "";
  const bulk =
    input.listUnsubscribe ||
    input.listId !== null ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk";
  const category = categorize(input, bulk);
  const guardrail = guardrailFor(input, category);
  const matched = rules.find((rule) => matchesRule(rule, input));
  const rule = matched ? { id: matched.id, action: matched.action, reason: matched.reason } : null;
  return {
    category,
    guardrail,
    bulk,
    rule,
  };
}
