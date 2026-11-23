// @effect-diagnostics nodeBuiltinImport:off - DKIM keys are DNS TXT records, which Effect can't resolve.
import * as NodeDnsPromises from "node:dns/promises";

import { MailError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";

import * as McpWebhookTransport from "../mcp/McpWebhookTransport.ts";

/** The network an unsubscribe touches: the signer's DKIM key and the sender's one-click URL. */
export class MailUnsubscribeTransport extends Context.Service<
  MailUnsubscribeTransport,
  {
    /** Each TXT record with its strings joined; empty when the name has none or DNS fails. */
    readonly resolveTxt: (name: string) => Promise<ReadonlyArray<string>>;
    readonly postOneClick: (url: URL) => Effect.Effect<void, MailError>;
  }
>()("t3/mail/MailUnsubscribeTransport") {}

const failed = (message: string) => new MailError({ code: "send_failed", message });

/**
 * One-click posts reach public addresses only, through a client pinned to the address it checked,
 * without cookies or credentials, and never follow a redirect (RFC 8058 §3.2).
 */
const make = () => {
  const guard = McpWebhookTransport.make([]);
  return Layer.effect(
    MailUnsubscribeTransport,
    Effect.gen(function* () {
      // Closing the request's scope releases the connection without reading the sender's reply.
      const client = HttpClient.withScope(yield* HttpClient.HttpClient);
      const resolver = new NodeDnsPromises.Resolver({ timeout: 5_000, tries: 2 });
      return MailUnsubscribeTransport.of({
        resolveTxt: (name) =>
          resolver
            .resolveTxt(name)
            .then((records) => records.map((chunks) => chunks.join("")))
            .catch(() => []),
        postOneClick: Effect.fn("MailUnsubscribeTransport.postOneClick")(function* (url: URL) {
          if (url.protocol !== "https:")
            return yield* failed("The sender's unsubscribe address isn't secure.");
          yield* guard
            .check(url)
            .pipe(
              Effect.mapError(() =>
                failed("The sender's unsubscribe address isn't on the public internet."),
              ),
            );
          const response = yield* client
            .execute(
              HttpClientRequest.post(url).pipe(
                HttpClientRequest.bodyText(
                  "List-Unsubscribe=One-Click",
                  "application/x-www-form-urlencoded",
                ),
              ),
            )
            .pipe(
              Effect.timeout("15 seconds"),
              Effect.mapError(() => failed("Couldn't reach the sender to unsubscribe.")),
            );
          if (response.status < 200 || response.status >= 300)
            return yield* failed(
              `The sender didn't confirm the unsubscribe (HTTP ${response.status}).`,
            );
        }, Effect.scoped),
      });
    }),
  ).pipe(Layer.provide(guard.layerClient));
};

export const layer = make();
