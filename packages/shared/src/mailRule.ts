import type { MailRule } from "@t3tools/contracts";

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).toLowerCase();
}

export function matchesRule(
  rule: MailRule,
  input: {
    readonly fromAddress: string;
    readonly subject: string;
    readonly listId?: string | null | undefined;
  },
): boolean {
  if (!rule.enabled) return false;
  const { from, domain, subjectContains, listId } = rule.match;
  // A rule with a condition may cover all mail; without one it needs a scope.
  if (!from && !domain && !subjectContains && !listId) return Boolean(rule.when);
  const address = input.fromAddress.toLowerCase();
  if (from && !`<${address}>`.includes(from.toLowerCase())) return false;
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
