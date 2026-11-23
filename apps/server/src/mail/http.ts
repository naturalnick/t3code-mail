import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { MailService } from "./MailService.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "mail",
  Effect.fnUntraced(function* (handlers) {
    const mail = yield* MailService;
    return handlers.handle(
      "attachment",
      Effect.fn("environment.mail.attachment")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* mail.getAttachment(args.payload);
      }),
    );
  }),
);
