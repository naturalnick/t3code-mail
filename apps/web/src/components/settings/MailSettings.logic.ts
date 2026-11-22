import type { MailRule } from "@t3tools/contracts";

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
