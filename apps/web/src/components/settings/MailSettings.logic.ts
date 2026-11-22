import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type MailRule,
  type UsageSummary,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";

export function mailUsageShare(
  environmentId: EnvironmentId,
  tokens: number,
  summary: UsageSummary | null,
) {
  if (
    !summary ||
    summary.sources.some(
      (source) => source.refreshing || source.status === "failed" || source.status === "partial",
    )
  )
    return null;
  const { totalTokens } = mergeUsage(
    [{ environmentId, label: "", summary }],
    USAGE_CONTRACT_VERSION,
  );
  // Text-generation estimates and incomplete provider coverage can exceed the recorded total.
  return totalTokens > 0 && tokens <= totalTokens ? tokens / totalTokens : null;
}

export function normalizeRule(rule: MailRule): MailRule | null {
  const match = Object.fromEntries(
    Object.entries(rule.match).flatMap(([key, raw]) => {
      const value = raw.trim();
      return value ? [[key, value]] : [];
    }),
  );
  return Object.keys(match).length === 0 ? null : { ...rule, match };
}

export function insertToneNotes(markdown: string, notes: string): string {
  const text = notes.trim();
  if (!text) return markdown;
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const heading = /^##[ \t]+Tone(?: and signature)?[ \t]*\r?$/im.exec(markdown);
  if (!heading) {
    return [markdown.trimEnd(), "## Tone", text].filter(Boolean).join(newline + newline) + newline;
  }
  const start = heading.index + heading[0].length;
  const next = /^#{1,2}[ \t]+/m.exec(markdown.slice(start));
  const end = next ? start + next.index : markdown.length;
  return (
    markdown.slice(0, end).trimEnd() +
    newline +
    text +
    newline +
    (next ? newline + markdown.slice(end) : "")
  );
}
