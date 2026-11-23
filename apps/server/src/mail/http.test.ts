// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off - real HTTP upload boundary test.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it as effectIt } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentMailHttpApi,
  MAIL_OUTGOING_FILE_BYTES,
  type MailUploadDraftFileInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import type * as NetAddress from "effect/net/NetAddress";

import { layer as mailHttpLayer } from "./http.ts";
import { MailService } from "./MailService.ts";

const principal = (...scopes: AuthEnvironmentScope[]) =>
  Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
    effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("mail-test"),
        subject: "test",
        method: "bearer-access-token",
        scopes: new Set(scopes),
      }),
    ),
  );

const serve = (scope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const uploads: Array<{ query: MailUploadDraftFileInput; size: number }> = [];
    const uploadDraftFile = vi.fn((query: MailUploadDraftFileInput, content: Uint8Array) => {
      uploads.push({ query, size: content.byteLength });
      return Effect.succeed({
        id: "file-00000000-0000-4000-8000-000000000001",
        filename: query.filename,
        contentType: "text/plain",
        size: content.byteLength,
      });
    });
    const routes = HttpApiBuilder.layer(
      HttpApi.make("environment").add(EnvironmentMailHttpApi),
    ).pipe(
      Layer.provide(mailHttpLayer),
      Layer.provide(principal(scope)),
      Layer.provide(Layer.mock(MailService)({ uploadDraftFile })),
    );
    yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
    const server = yield* HttpServer.HttpServer;
    const address = server.address as NetAddress.InetAddress;
    const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
    const url = `http://${host}:${address.port}/api/mail/draft-file?accountId=acct&filename=notes.txt`;
    const post = (body: NonNullable<RequestInit["body"]>) =>
      Effect.promise(() =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body,
          duplex: "half",
        } as RequestInit),
      );
    return { post, uploads };
  });

effectIt.live("refuses draft uploads from read-only sessions", () =>
  Effect.gen(function* () {
    const { post, uploads } = yield* serve(AuthOrchestrationReadScope);
    expect((yield* post(new Uint8Array(4))).status).toBe(403);
    expect(uploads).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

effectIt.live("stores a draft upload within the size limit and refuses a larger one", () =>
  Effect.gen(function* () {
    const { post, uploads } = yield* serve(AuthOrchestrationOperateScope);
    const ok = yield* post(new Uint8Array(5));
    expect(ok.status).toBe(200);
    expect(yield* Effect.promise(() => ok.json())).toMatchObject({
      filename: "notes.txt",
      size: 5,
    });
    const big = yield* post(new Uint8Array(MAIL_OUTGOING_FILE_BYTES + 1));
    expect(big.status).toBe(413);
    const chunked = yield* post(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAIL_OUTGOING_FILE_BYTES));
          controller.enqueue(new Uint8Array(4));
          controller.close();
        },
      }),
    );
    expect(chunked.status).toBe(413);
    expect(uploads).toEqual([{ query: { accountId: "acct", filename: "notes.txt" }, size: 5 }]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
