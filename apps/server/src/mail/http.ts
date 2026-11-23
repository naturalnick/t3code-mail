import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentMailUploadBodyLimit,
  MAIL_OUTGOING_FILE_BYTES,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { MailService } from "./MailService.ts";

// Refuses an oversized upload before reading it, and caps a body sent without a length.
const uploadBodyLimit = Layer.succeed(EnvironmentMailUploadBodyLimit, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (Number(request.headers["content-length"]) > MAIL_OUTGOING_FILE_BYTES)
      return HttpServerResponse.empty({ status: 413 });
    return yield* effect.pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        ByteSize.bytes(MAIL_OUTGOING_FILE_BYTES),
      ),
    );
  }),
);

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "mail",
  Effect.fnUntraced(function* (handlers) {
    const mail = yield* MailService;
    return handlers
      .handle(
        "attachment",
        Effect.fn("environment.mail.attachment")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* mail.getAttachment(args.payload);
        }),
      )
      .handle(
        "uploadDraftFile",
        Effect.fn("environment.mail.uploadDraftFile")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // Same permission as saving the draft the file is for.
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* mail.uploadDraftFile(args.query, args.payload);
        }),
      );
  }),
).pipe(Layer.provide(uploadBodyLimit));
