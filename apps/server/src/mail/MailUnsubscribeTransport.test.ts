import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import * as MailUnsubscribeTransport from "./MailUnsubscribeTransport.ts";

it.effect("one-click posts refuse plain HTTP and private addresses before connecting", () =>
  Effect.gen(function* () {
    const transport = yield* MailUnsubscribeTransport.MailUnsubscribeTransport;
    const refused = yield* Effect.forEach(
      ["http://example.com/u", "https://127.0.0.1/u", "https://[::1]/u", "https://10.0.0.8/u"],
      (url) => transport.postOneClick(new URL(url)).pipe(Effect.flip),
    );
    expect(refused.map((error) => error.message)).toEqual([
      "The sender's unsubscribe address isn't secure.",
      ...Array(3).fill("The sender's unsubscribe address isn't on the public internet."),
    ]);
  }).pipe(Effect.provide(MailUnsubscribeTransport.layer)),
);
