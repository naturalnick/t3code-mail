// Cleaning runs on every synced message, so it is plain string work with no parser dependency.

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "-",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  zwnj: "",
  zwj: "",
  shy: "",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const INVISIBLE = /[\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff\u00ad]|\u034f/g;

export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, "")
    // Preheaders and other hidden blocks exist only for inbox previews and trackers.
    .replace(
      /<(div|span|p|td|table)\b[^>]*style\s*=\s*["'][^"']*(display\s*:\s*none|max-height\s*:\s*0|font-size\s*:\s*0|opacity\s*:\s*0)[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi,
      "",
    )
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(
      /<\/(p|div|tr|h[1-6]|li|ul|ol|table|blockquote|section|article|header|footer)\s*>/gi,
      "\n",
    )
    .replace(/<(p|div|tr|h[1-6]|table|blockquote|section|article|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text).replace(INVISIBLE, "");
  return normalizeWhitespace(text);
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const QUOTE_HEADER_PATTERNS = [
  /^On .{6,200}wrote:\s*$/m,
  /^On .{6,120}\n.{0,120}wrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
  /^_{10,}\s*$/m,
  /^From: .+\n(Sent|Date): .+\n(To|Subject): /m,
  /^Le .{6,200}a écrit\s*:\s*$/m,
  /^Am .{6,200}schrieb .{0,120}:\s*$/m,
  /^El .{6,200}escribió:\s*$/m,
];

export const asksQuestion = (text: string): boolean => /[?？]\s*$/m.test(text);

/** Drops the quoted chain under a reply. Forwarded content counts as quoted for the model. */
export function stripQuoted(text: string): string {
  let cut = text.length;
  for (const pattern of QUOTE_HEADER_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match.index > 0 && match.index < cut) cut = match.index;
  }
  return text
    .slice(0, cut)
    .split("\n")
    .filter((line) => !line.startsWith(">"))
    .join("\n")
    .trim();
}

const SIGNATURE_PATTERNS = [
  /\n-- ?\n[\s\S]*$/,
  /\n(Sent from my (iPhone|iPad|Android|phone|mobile device)|Get Outlook for (iOS|Android)|Sent from (Mail|Outlook|Yahoo Mail) for [\w ]+)[\s\S]*$/i,
];

function stripSignature(text: string): string {
  let result = text;
  for (const pattern of SIGNATURE_PATTERNS) result = result.replace(pattern, "");
  return result.trim();
}

const FOOTER_LINE =
  /unsubscribe|manage (your )?(email )?preferences|email preferences|view (this email )?in (your )?browser|you('re| are) receiving this|update your preferences|privacy policy|all rights reserved/i;

/** Long links, footers and tracking lines carry nothing a summary needs. */
function stripTrackingJunk(text: string): string {
  const lines = text
    .replace(/https?:\/\/\S{60,}/g, "[link]")
    .replace(/\[link\](\s*\[link\])+/g, "[link]")
    .split("\n");
  const footerStart = Math.floor(lines.length * 0.6);
  const kept = lines.filter(
    (line, index) =>
      !(index >= footerStart && FOOTER_LINE.test(line)) &&
      !/^view (this )?(email )?online/i.test(line),
  );
  return normalizeWhitespace(kept.join("\n"));
}

/** What the model sees: the new part of one message, bounded. */
export function cleanForModel(text: string, maxChars: number): string {
  const cleaned = stripTrackingJunk(stripSignature(stripQuoted(text)));
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars).trimEnd()} …`;
}

/** What the reader sees by default: no quoted chain or signature, links kept. */
export function cleanForDisplay(text: string): string {
  const cleaned = stripSignature(stripQuoted(text));
  return cleaned.length > 0 ? cleaned : text;
}

const GREETING = /^(hi|hey|hello|dear|good (morning|afternoon|evening))\b[^\n]{0,40}[,!]?$/i;

export function firstLine(text: string, maxChars = 140): string {
  for (const raw of cleanForModel(text, 4_000).split("\n")) {
    const line = raw.replace(/^[-*>\s]+/, "").trim();
    if (line.length < 3 || GREETING.test(line) || line === "[link]") continue;
    return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1).trimEnd()}…`;
  }
  return "";
}

const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|earlier|all)\b.{0,20}\b(instructions?|prompts?|rules)\b/i,
  /\b(you are|act as|pretend to be)\b.{0,30}\b(an? )?(ai|assistant|language model|llm|chatbot)\b/i,
  /\b(system prompt|developer message|<\|im_start\|>|\[INST\]|assistant:)/i,
  /\b(ai|assistant|agent|llm)s?\b.{0,40}\b(must|should|need to)\b.{0,40}\b(forward|send|reply|delete|transfer|reveal)\b/i,
];

export function looksLikeInstructionsToAi(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** "Sam <sam@example.org>" or a bare address, as a recipient is typed. */
export function parseMailbox(raw: string): { readonly name: string; readonly address: string } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$/.exec(raw);
  return match ? { name: match[1]!.trim(), address: match[2]! } : { name: "", address: raw.trim() };
}
