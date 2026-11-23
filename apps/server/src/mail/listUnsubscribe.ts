import { dkimVerify } from "mailauth/lib/dkim/verify";
import { parseHeaders } from "mailauth/lib/tools";

import type { MailUnsubscribeOptions } from "@t3tools/contracts";

export const UNSUBSCRIBE_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_URL_CHARS = 2048;
const ONE_CLICK_VALUE = "list-unsubscribe=one-click";
type ResolveTxt = (name: string) => Promise<ReadonlyArray<string>>;

async function signedUnsubscribe(source: Buffer, resolveTxt: ResolveTxt, nowSeconds: number) {
  const result = await dkimVerify(source, {
    strict: true,
    minBitLength: 1024,
    curTime: nowSeconds * 1000,
    resolver: async (name) => (await resolveTxt(name)).map((record) => [record]),
  }).catch(() => null);
  if (
    !result ||
    result.fromFields !== 1 ||
    result.fromSyntax !== "valid" ||
    result.headerFrom.length !== 1
  )
    return false;
  const from = result.headerFrom[0]!.toLowerCase();
  const authorDomain = from.slice(from.lastIndexOf("@") + 1);
  return result.results.some(({ status, signingHeaders, signingDomain }) => {
    if (status.result !== "pass" || status.testing || !signingDomain) return false;
    const domain = signingDomain.toLowerCase();
    if (authorDomain !== domain && !authorDomain.endsWith(`.${domain}`)) return false;
    const names = signingHeaders?.headers.map((line) =>
      line.slice(0, line.indexOf(":")).trim().toLowerCase(),
    );
    return (
      names?.includes("list-unsubscribe") &&
      names.includes("list-unsubscribe-post") &&
      names.includes("from")
    );
  });
}

export interface UnsubscribeEmail {
  readonly address: string;
  readonly subject: string;
  readonly body: string;
}

const singleLine = (value: string, max: number) =>
  value
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, max);

function parseMailto(uri: string): UnsubscribeEmail | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  let address: string;
  try {
    address = decodeURIComponent(url.pathname).trim();
  } catch {
    return null;
  }
  if (!/^[^\s@<>,;:"()[\]\\]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(address)) return null;
  return {
    address,
    subject: singleLine(url.searchParams.get("subject") ?? "", 200) || "Unsubscribe",
    body: (url.searchParams.get("body") ?? "").slice(0, 2000) || "Unsubscribe",
  };
}

function parseWeb(uri: string): URL | null {
  if (uri.length > MAX_URL_CHARS) return null;
  try {
    const url = new URL(uri);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
      ? url
      : null;
  } catch {
    return null;
  }
}

export type UnsubscribePlan = Omit<
  MailUnsubscribeOptions,
  "confirmation" | "emailPreview" | "sender"
> & {
  /** Where the request goes: the one-click URL, or the email to send. */
  readonly oneClickUrl: URL | null;
  readonly email: UnsubscribeEmail | null;
};

/**
 * What the sender's List-Unsubscribe (RFC 2369) offers. One-click (RFC 8058) needs exactly one
 * List-Unsubscribe and List-Unsubscribe-Post, both covered by a valid DKIM signature from the
 * From domain or a parent of it, so a forged header can't make Mail post to someone else's URL.
 */
export async function planUnsubscribe(
  source: Buffer,
  resolveTxt: ResolveTxt,
  nowSeconds: number,
): Promise<UnsubscribePlan | null> {
  const boundary = /\r?\n\r?\n/.exec(
    source.toString("latin1", 0, Math.min(source.length, 256 * 1024)),
  );
  if (!boundary && source.length >= 256 * 1024) return null;
  const { parsed } = parseHeaders(source.subarray(0, boundary?.index ?? source.length));
  const named = (name: string) =>
    parsed
      .filter((field) => field.key === name)
      .map(({ line }) => {
        const raw = line.toString("latin1");
        return raw
          .slice(raw.indexOf(":") + 1)
          .replace(/\r?\n/g, "")
          .trim();
      });
  const lists = named("list-unsubscribe");
  if (lists.length === 0) return null;
  const uris = lists.flatMap((header) =>
    [...header.matchAll(/<([^<>]*)>/g)].map((match) => match[1]!.replace(/\s+/g, "")),
  );
  const web = uris.map(parseWeb).find((url) => url !== null) ?? null;
  const https = web?.protocol === "https:" ? web : null;
  const email =
    uris
      .filter((uri) => /^mailto:/i.test(uri))
      .map(parseMailto)
      .find((entry) => entry !== null) ?? null;

  let oneClick: URL | null = null;
  const posts = named("list-unsubscribe-post");
  const signatures = parsed.filter(
    ({ key }) => key === "dkim-signature" || key === "arc-message-signature",
  );
  if (
    https &&
    lists.length === 1 &&
    posts.length === 1 &&
    posts[0]!.toLowerCase() === ONE_CLICK_VALUE &&
    signatures.length > 0 &&
    signatures.length <= 5 &&
    (await signedUnsubscribe(source, resolveTxt, nowSeconds))
  ) {
    oneClick = https;
  }

  const pageUrl = web?.href ?? null;
  if (oneClick)
    return { method: "one_click", target: oneClick.host, pageUrl, oneClickUrl: oneClick, email };
  if (email) return { method: "email", target: email.address, pageUrl, oneClickUrl: null, email };
  if (web) return { method: "link", target: web.host, pageUrl, oneClickUrl: null, email: null };
  return null;
}
