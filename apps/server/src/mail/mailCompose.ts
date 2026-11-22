import type { MailAddress, MailDraftMode } from "@t3tools/contracts";

/** The message a reply quotes or a forward carries. */
export interface ComposeSource {
  readonly from: MailAddress;
  readonly to: ReadonlyArray<MailAddress>;
  readonly cc: ReadonlyArray<MailAddress>;
  readonly date: string;
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  /** cid → data URL, as the reader caches it. */
  readonly inlineImages: Readonly<Record<string, string>>;
}

export interface ComposedFile {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
  /** Set for images the HTML shows inline. */
  readonly cid?: string;
}

export interface ComposedMessage {
  readonly text: string;
  readonly html: string | null;
  readonly attachments: ReadonlyArray<ComposedFile>;
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const formatAddress = (entry: MailAddress) =>
  entry.name && entry.name !== entry.address ? `${entry.name} <${entry.address}>` : entry.address;

const formatList = (entries: ReadonlyArray<MailAddress>) => entries.map(formatAddress).join(", ");

/** "Thu, Nov 5, 2026 at 9:46 PM", the attribution style mail clients recognize. */
function formatQuoteDate(iso: string, timeZone?: string): string {
  const date = Date.parse(iso);
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
  return `${day} at ${time}`;
}

const quoteText = (text: string) =>
  text
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");

const ACTIVE_ELEMENTS =
  "script|style|title|iframe|object|embed|form|textarea|select|button|svg|math";

/**
 * The sender's markup to nest inside ours: no document shell, stylesheets or active content, so
 * nothing in the original can restyle or script the user's own text. Inline styles stay.
 */
function innerHtml(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return body
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(new RegExp(`<(${ACTIVE_ELEMENTS})\\b[\\s\\S]*?<\\/\\1\\s*>`, "gi"), "")
    .replace(
      new RegExp(`<\\/?(${ACTIVE_ELEMENTS}|html|head|body|meta|link|base|input)\\b[^>]*>`, "gi"),
      "",
    )
    .replace(/\s(on[a-z]+|formaction|srcdoc)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["']?)\s*(javascript|vbscript):[^"'\s>]*\2/gi, '$1="#"');
}

const paragraphs = (text: string) =>
  text
    .split("\n")
    .map((line) => `<div dir="auto">${line.length === 0 ? "<br>" : escapeHtml(line)}</div>`)
    .join("");

function dataUrlFile(cid: string, url: string): ComposedFile | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) return null;
  return {
    filename: cid,
    contentType: match[1]!,
    content: Buffer.from(match[2]!, "base64"),
    cid,
  };
}

/**
 * Builds what is sent: the user's text, then the quoted or forwarded message in both plain text
 * and HTML, the way Gmail and Apple Mail lay them out, so every recipient's client recognizes them.
 */
export function composeOutgoing(input: {
  readonly mode: MailDraftMode;
  readonly body: string;
  readonly source: ComposeSource | null;
  readonly files: ReadonlyArray<ComposedFile>;
  readonly timeZone?: string;
}): ComposedMessage {
  const { mode, source } = input;
  const body = input.body.replace(/\s+$/, "");
  if (source === null) return { text: body, html: null, attachments: input.files };
  const date = formatQuoteDate(source.date, input.timeZone);
  const original = source.text?.replace(/\s+$/, "") ?? "";
  const originalHtml =
    source.html !== null
      ? innerHtml(source.html)
      : `<div dir="auto">${escapeHtml(original).replaceAll("\n", "<br>")}</div>`;
  const fetched = new Set(input.files.flatMap((file) => (file.cid ? [file.cid] : [])));
  const inline = Object.entries(source.inlineImages)
    .filter(([cid]) => !fetched.has(cid) && originalHtml.includes(`cid:${cid}`))
    .flatMap(([cid, url]) => {
      const file = dataUrlFile(cid, url);
      return file ? [file] : [];
    });
  if (mode === "forward") {
    const header = [
      "---------- Forwarded message ---------",
      `From: ${formatAddress(source.from)}`,
      `Date: ${date}`,
      `Subject: ${source.subject}`,
      `To: ${formatList(source.to)}`,
      ...(source.cc.length > 0 ? [`Cc: ${formatList(source.cc)}`] : []),
    ];
    const htmlHeader = header
      .map((line, index) =>
        index === 1
          ? `From: <strong class="gmail_sendername" dir="auto">${escapeHtml(source.from.name || source.from.address)}</strong> <span dir="auto">&lt;${escapeHtml(source.from.address)}&gt;</span>`
          : escapeHtml(line),
      )
      .join("<br>");
    return {
      text: [body, "", header.join("\n"), "", original].join("\n"),
      html: `${paragraphs(body)}<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${htmlHeader}<br></div><br><br>${originalHtml}</div>`,
      attachments: [...inline, ...input.files],
    };
  }
  const attribution = `On ${date}, ${formatAddress(source.from)} wrote:`;
  if (original.length === 0 && source.html === null) {
    return { text: body, html: null, attachments: input.files };
  }
  return {
    text: [body, "", attribution, "", quoteText(original)].join("\n"),
    html: `${paragraphs(body)}<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(attribution)}<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${originalHtml}</blockquote></div>`,
    attachments: [...inline, ...input.files],
  };
}
