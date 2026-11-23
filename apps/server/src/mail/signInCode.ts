import { stripQuoted } from "./mailText.ts";

const code = String.raw`(?<![\w-])(?:\d{3}[- ]\d{3}|\d{4,8})(?![\w-])`;
const label = String.raw`(?:sign[- ]in|log[- ]?in|verification|authentication|security|one[- ]time)(?:\s+(?:verification|security))?\s+(?:code|passcode|password)|OTP`;
const labeledCode = new RegExp(
  String.raw`\b(?:${label})\b(?:\s+is)?[\s:#\p{Pd}]*(${code})|(${code})\s+is\s+your\s+(?:${label})\b`,
  "giu",
);
const useToSignIn = new RegExp(
  String.raw`\b(?:use|enter)\s+(?:(?:this |the )?(?:code|passcode)[:\s]+)?(${code})\s+to\s+(?:sign[- ]in|log[- ]in|verify your identity)\b`,
  "gi",
);
const labeledSubject = new RegExp(String.raw`\b(?:${label})\b`, "i");
const standaloneCode = new RegExp(String.raw`^\s*(${code})\s*$`, "gm");
const excluded =
  /\b(?:recovery codes?|backup codes?|security alert|(?:new|unrecognized|unrecognised|suspicious) (?:login|sign.in|device)|payment|purchase|bank transfer|delivery code|pickup code|password (?:reset|changed?)|reset your password|receipt|invoice|order confirmation|transaction|authorize (?:a |this )?payment)\b/i;

/** Null for ambiguous mail, zero for a code without a stated lifetime, otherwise milliseconds. */
export function signInCodeLifetime(subject: string, body: string): number | null {
  const text = stripQuoted(body).slice(0, 8000);
  if (/^\s*(?:re|fw|fwd):/i.test(subject) || excluded.test(subject + "\n" + text)) return null;
  const codes = new Set<string>();
  for (const part of [subject, text]) {
    for (const match of part.matchAll(useToSignIn)) codes.add(match[1]!.replace(/\D/g, ""));
    for (const match of part.matchAll(labeledCode))
      codes.add((match[1] ?? match[2])!.replace(/\D/g, ""));
  }
  if (labeledSubject.test(subject)) {
    for (const match of text.matchAll(standaloneCode)) codes.add(match[1]!.replace(/\D/g, ""));
  }
  if (codes.size !== 1) return null;
  const duration =
    /\b(?:expires? (?:in|after)|valid for)\s+(?:the next\s+)?(\d{1,4})\s*(seconds?|minutes?|hours?)\b/i.exec(
      subject + "\n" + text,
    );
  if (!duration) return 0;
  const unit = duration[2]!.toLowerCase();
  return Math.max(
    1,
    Number(duration[1]) *
      (unit.startsWith("hour") ? 3600000 : unit.startsWith("min") ? 60000 : 1000),
  );
}
