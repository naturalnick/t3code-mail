import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { MailError, type EnvironmentId, type MailAttachmentInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AtomRegistry } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const isMailAttachmentError = Schema.is(MailError);

export function fetchMailAttachment(
  environmentId: EnvironmentId,
  payload: MailAttachmentInput,
  signal: AbortSignal,
) {
  const load = Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (registry) =>
    registry.run(
      environmentId,
      executeConnectedEnvironmentHttpRequest({
        group: "mail",
        method: "POST",
        url: (urls) => urls.attachment(),
        timeoutMs: 180_000,
        request: ({ client, headers }) => client.attachment({ payload, headers }),
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "RemoteEnvironmentAuthFetchError" && isMailAttachmentError(error.cause)
            ? error.cause
            : error,
        ),
      ),
    ),
  );
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) => Effect.provide(load, context)),
    ),
    { signal },
  );
}
