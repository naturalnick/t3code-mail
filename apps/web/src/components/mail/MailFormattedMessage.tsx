import type { MailFormattedBody } from "@t3tools/contracts";
import DOMPurify from "dompurify";
import { useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";
import { observeResize } from "../../lib/observeResize";
import { InlineButton } from "../ui/button";

function prepareDocument(body: MailFormattedBody, loadImages: boolean) {
  // A template's inert owner document cannot fetch sender-controlled resources while sanitizing.
  const template = document.createElement("template");
  template.innerHTML = body.html;
  const content = template.content.ownerDocument.createElement("div");
  content.append(template.content);
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
  let remoteImages = false;
  for (const img of content.querySelectorAll("img")) {
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
  for (const link of content.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? "";
    if (!/^(https?:\/\/|mailto:)/i.test(href)) link.removeAttribute("href");
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  const policy = `default-src 'none'; img-src data:${loadImages ? " https: http:" : ""}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html{color-scheme:light;background:white;color:#171717;font:15px/1.5 system-ui,sans-serif;overflow-x:hidden}body{display:flow-root;margin:0;padding:8px;overflow-wrap:anywhere}*,*::before,*::after{box-sizing:border-box}table,div,img,td,th,pre{max-width:100%!important}img{object-fit:contain;height:auto}pre{white-space:pre-wrap}@media(max-width:640px){table{table-layout:fixed}td,th{min-width:0!important;white-space:normal!important}}</style></head><body>${content.innerHTML}</body></html>`;
  return { srcDoc, remoteImages };
}

export function MailFormattedMessage({ body, title }: { body: MailFormattedBody; title: string }) {
  const gt = useGT();
  const [loadImages, setLoadImages] = useState(false);
  const { srcDoc, remoteImages } = prepareDocument(body, loadImages);
  const stop = useRef<(() => void) | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The observer belongs to the iframe document and must be disconnected on unmount.
  useEffect(() => () => stop.current?.(), []);
  return (
    <>
      {remoteImages && !loadImages && (
        <InlineButton tone="muted" onClick={() => setLoadImages(true)}>
          {gt("Load remote images")}
        </InlineButton>
      )}
      <iframe
        title={title}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        className="block w-full min-w-0 border-0"
        onLoad={(event) => {
          stop.current?.();
          const frame = event.currentTarget;
          const element = frame.contentDocument?.body;
          if (!element) return;
          // Viewport-relative email styles can otherwise grow the frame every time it resizes.
          const resize = () => {
            frame.style.height =
              Math.min(Math.ceil(element.getBoundingClientRect().height), window.innerHeight * 3) +
              "px";
          };
          stop.current = observeResize(element, resize);
          resize();
        }}
      />
    </>
  );
}
