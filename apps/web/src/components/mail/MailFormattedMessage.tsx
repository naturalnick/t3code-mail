import type { MailFormattedBody } from "@t3tools/contracts";
import DOMPurify from "dompurify";
import { useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { EllipsisIcon } from "lucide-react";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readerView } from "./mailReader";

const QUOTE_SELECTORS = [
  ".gmail_quote",
  "blockquote.t3-cite",
  ".yahoo_quoted",
  ".protonmail_quote",
  "#mail-editor-reference-message-container",
  "#divRplyFwdMsg",
  "#appendonsend",
].join(",");

/** A forward's quoted block is the message itself, so it is never folded away. */
const isForwarded = (element: Element) =>
  /forwarded message|begin forwarded/i.test(
    `${element.previousElementSibling?.textContent ?? ""} ${element.textContent ?? ""}`.slice(
      0,
      400,
    ),
  );

/**
 * Marks the earlier conversation a reply carries, the way Gmail and Outlook nest it, so the reader
 * can fold it. Outlook puts its header first and the old mail after it as siblings.
 */
function markQuotedHistory(content: HTMLElement): boolean {
  const quote = [...content.querySelectorAll(QUOTE_SELECTORS)].find(
    (element) => !element.parentElement?.closest(QUOTE_SELECTORS) && !isForwarded(element),
  );
  if (!quote) return false;
  const folded: Array<Element> = [quote];
  if (quote.id === "divRplyFwdMsg" || quote.id === "appendonsend") {
    for (let next = quote.nextElementSibling; next; next = next.nextElementSibling)
      folded.push(next);
    const rule = quote.previousElementSibling;
    if (rule?.tagName === "HR") folded.push(rule);
  }
  const before = content.textContent?.trim().length ?? 0;
  const quoted = folded.reduce((total, node) => total + (node.textContent?.trim().length ?? 0), 0);
  // Folding everything would leave an empty message.
  if (before - quoted < 1) return false;
  for (const node of folded) node.setAttribute("data-t3-quote", "");
  return true;
}

function sanitize(body: MailFormattedBody) {
  // A template's inert owner document cannot fetch sender-controlled resources while sanitizing.
  const template = document.createElement("template");
  template.innerHTML = body.html;
  const content = template.content.ownerDocument.createElement("div");
  content.append(template.content);
  // Apple Mail marks quotes with a `type` attribute the sanitizer drops, so carry it as a class.
  for (const quote of content.querySelectorAll("blockquote[type=cite]"))
    quote.classList.add("t3-cite");
  DOMPurify.sanitize(content, {
    IN_PLACE: true,
    ALLOWED_TAGS:
      "a address article aside b big blockquote br caption center code col colgroup dd del div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins li main ol p pre s section small span strong style sub sup table tbody td tfoot th thead tr u ul".split(
        " ",
      ),
    ALLOWED_ATTR:
      "align alt bgcolor border cellpadding cellspacing class color colspan dir face height href id lang role rowspan size src style title valign width".split(
        " ",
      ),
    ALLOW_DATA_ATTR: false,
  });
  for (const link of content.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? "";
    if (!/^(https?:\/\/|mailto:)/i.test(href)) link.removeAttribute("href");
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  const hasQuote = markQuotedHistory(content);
  return { content, hasQuote };
}

// Parsing and rebuilding a large email is the expensive part, so toggles and remounts reuse it.
const prepared = new WeakMap<MailFormattedBody, ReturnType<typeof prepareBody>>();

function prepareBody(body: MailFormattedBody) {
  const sanitized = sanitize(body);
  return { ...sanitized, reader: readerView(sanitized.content) };
}

function prepare(body: MailFormattedBody) {
  let entry = prepared.get(body);
  if (entry === undefined) {
    entry = prepareBody(body);
    prepared.set(body, entry);
  }
  return entry;
}

function originalDocument(
  content: HTMLElement,
  body: MailFormattedBody,
  loadImages: boolean,
  showQuoted: boolean,
) {
  // `content` is shared with the reader across renders, so image sources are rewritten on a copy.
  const frame = content.cloneNode(true) as HTMLElement;
  let remoteImages = false;
  for (const img of frame.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    img.removeAttribute("src");
    const cid = src.match(/^cid:(.+)$/i)?.[1];
    const embedded = cid ? body.inlineImages[cid] : src;
    if (
      typeof embedded === "string" &&
      /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]+=*$/i.test(embedded)
    ) {
      img.setAttribute("src", embedded);
    } else if (/^(?:https?:)?\/\//i.test(src)) {
      remoteImages = true;
      if (loadImages) img.setAttribute("src", src.startsWith("//") ? "https:" + src : src);
    }
  }
  const policy = `default-src 'none'; img-src data:${loadImages ? " https: http:" : ""}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html{color-scheme:light;background:white;color:#171717;font:15px/1.5 system-ui,sans-serif;overflow:hidden}html,body{height:auto!important;min-height:0!important}body{display:flow-root;margin:0;padding:8px;overflow-wrap:anywhere}*,*::before,*::after{box-sizing:border-box}table,div,img,td,th,pre{max-width:100%!important}img{object-fit:contain;height:auto}pre{white-space:pre-wrap}${showQuoted ? "" : "[data-t3-quote]{display:none!important}"}@media(max-width:640px){table{table-layout:fixed}td,th{min-width:0!important;white-space:normal!important}}</style></head><body>${frame.innerHTML}</body></html>`;
  return { srcDoc, remoteImages };
}

const MAX_REMEMBERED_HEIGHTS = 200;
const MAX_FRAME_HEIGHT = 40_000;
// Each message's last measured height, so reopening an email lays it out once instead of growing.
const measuredHeights = new Map<string, number>();

export function rememberedMessageHeight(id: string): number | undefined {
  return measuredHeights.get(id);
}

function rememberHeight(id: string, height: number) {
  measuredHeights.delete(id);
  measuredHeights.set(id, height);
  if (measuredHeights.size > MAX_REMEMBERED_HEIGHTS) {
    const oldest = measuredHeights.keys().next().value;
    if (oldest !== undefined) measuredHeights.delete(oldest);
  }
}

export function MailFormattedMessage({
  id,
  body,
  title,
}: {
  id: string;
  body: MailFormattedBody;
  title: string;
}) {
  const gt = useGT();
  const [choice, setChoice] = useState<"reader" | "original" | null>(null);
  const [showQuoted, setShowQuoted] = useState(false);
  const [loadImages, setLoadImages] = useState(false);
  const { content, hasQuote, reader } = prepare(body);
  const preferred = reader.useful ? "reader" : "original";
  const mode = choice ?? preferred;
  const original =
    mode === "original" ? originalDocument(content, body, loadImages, showQuoted) : null;
  const frameKey = `frame:${[id, mode, showQuoted && "quoted"].filter(Boolean).join(":")}`;
  // The loading placeholder stands in for the whole message as it first opens.
  const opening = mode === preferred && !showQuoted;
  const offerImages = original !== null && original.remoteImages && !loadImages;
  return (
    <div
      ref={(element) => {
        if (!element || !opening) return;
        return observeResize(element, () => rememberHeight(id, element.offsetHeight));
      }}
    >
      {reader.hasText || offerImages ? (
        <div className="mb-2 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs">
          {offerImages ? (
            <InlineButton tone="muted" onClick={() => setLoadImages(true)}>
              {gt("Load images")}
            </InlineButton>
          ) : null}
          {reader.hasText ? (
            <InlineButton
              tone="muted"
              onClick={() => setChoice(mode === "reader" ? "original" : "reader")}
            >
              {mode === "reader" ? gt("Show original") : gt("Show simplified")}
            </InlineButton>
          ) : null}
        </div>
      ) : null}
      {original === null ? (
        <div
          className={cn(
            "mail-reader chat-markdown text-sm leading-relaxed wrap-anywhere",
            !showQuoted && "[&_[data-t3-quote]]:hidden",
          )}
          // Built only from the reader's own elements and checked link destinations.
          dangerouslySetInnerHTML={{ __html: reader.html }}
        />
      ) : (
        <OriginalFrame srcDoc={original.srcDoc} title={title} heightKey={frameKey} />
      )}
      {hasQuote ? (
        <div className="mt-2">
          <QuotedToggle shown={showQuoted} onToggle={() => setShowQuoted(!showQuoted)} />
        </div>
      ) : null}
    </div>
  );
}

function OriginalFrame({
  srcDoc,
  title,
  heightKey,
}: {
  srcDoc: string;
  title: string;
  heightKey: string;
}) {
  const remembered = measuredHeights.get(heightKey);
  const [measured, setMeasured] = useState(remembered !== undefined);
  const stop = useRef<(() => void) | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The observer belongs to the iframe document and must be disconnected on unmount.
  useEffect(() => () => stop.current?.(), []);
  return (
    <iframe
      title={title}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      // Hidden until measured so the default iframe height never shows.
      className={cn("block w-full min-w-0 border-0", !measured && "invisible")}
      style={remembered === undefined ? undefined : { height: remembered }}
      onLoad={(event) => {
        stop.current?.();
        const frame = event.currentTarget;
        const element = frame.contentDocument?.body;
        if (!element) return;
        const resize = () => {
          // Fixed-width layouts shrink to the panel instead of scrolling inside it.
          element.style.zoom = "";
          const width = frame.clientWidth;
          const natural = element.scrollWidth;
          if (natural > width) element.style.zoom = String(width / natural);
          // The cap stops viewport-relative email styles from growing the frame forever.
          const height = Math.min(
            Math.ceil(element.getBoundingClientRect().height),
            MAX_FRAME_HEIGHT,
          );
          frame.style.height = height + "px";
          rememberHeight(heightKey, height);
          setMeasured(true);
        };
        stop.current = observeResize(element, resize);
        resize();
      }}
    />
  );
}

/** The "•••" Gmail shows for folded history. */
export function QuotedToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const gt = useGT();
  const label = shown ? gt("Hide earlier messages") : gt("Show earlier messages");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="secondary"
            aria-label={label}
            aria-pressed={shown}
            onClick={onToggle}
          />
        }
      >
        <EllipsisIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
