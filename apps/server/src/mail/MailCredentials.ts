// @effect-diagnostics nodeBuiltinImport:off - the keychain binding is a CommonJS native module loaded on demand.
import * as NodeModule from "node:module";

import type { MailAccountId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const KEYCHAIN_SERVICE = "T3 Code Mail";

export class MailCredentialError extends Schema.TaggedError<MailCredentialError>()(
  "MailCredentialError",
  {
    accountId: Schema.String,
    operation: Schema.Literals(["read", "write", "remove"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the app password for this mail account.`;
  }
}

export type CredentialStore = "keychain" | "file";

export class MailCredentials extends Context.Service<
  MailCredentials,
  {
    /** Stores the app password; returns where it went. */
    readonly put: (
      accountId: MailAccountId,
      password: string,
    ) => Effect.Effect<CredentialStore, MailCredentialError>;
    readonly get: (
      accountId: MailAccountId,
      store: CredentialStore,
    ) => Effect.Effect<string | null, MailCredentialError>;
    readonly remove: (
      accountId: MailAccountId,
      store: CredentialStore,
    ) => Effect.Effect<void, MailCredentialError>;
  }
>()("t3/mail/MailCredentials") {}

interface KeyringEntry {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | null | undefined>;
  deletePassword(): Promise<unknown>;
}

const requireExternal = NodeModule.createRequire(import.meta.url);

// A native binding that fails to load must not take mail down; the secrets folder still works.
const loadKeyring = (): ((service: string, account: string) => KeyringEntry) | null => {
  // Lets tests and headless setups skip the OS keychain entirely.
  if (process.env.T3CODE_MAIL_CREDENTIALS === "file") return null;
  try {
    const keyring = requireExternal("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
    return (service, account) => new keyring.AsyncEntry(service, account);
  } catch {
    return null;
  }
};

const secretName = (accountId: MailAccountId) =>
  `mail-app-password-${accountId.replace(/[^\w-]/g, "_")}`;

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const keyring = loadKeyring();

  const put: MailCredentials["Service"]["put"] = Effect.fn("MailCredentials.put")(
    function* (accountId, password) {
      if (keyring !== null) {
        const stored = yield* Effect.tryPromise({
          try: async () => {
            const entry = keyring(KEYCHAIN_SERVICE, accountId);
            await entry.setPassword(password);
            return (await entry.getPassword()) === password;
          },
          catch: (cause) => new MailCredentialError({ accountId, operation: "write", cause }),
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed(() => false),
        );
        if (stored) return "keychain" as const;
      }
      yield* secrets
        .set(secretName(accountId), new TextEncoder().encode(password))
        .pipe(
          Effect.mapError(
            (cause) => new MailCredentialError({ accountId, operation: "write", cause }),
          ),
        );
      return "file" as const;
    },
  );

  const get: MailCredentials["Service"]["get"] = (accountId, store) =>
    store === "keychain"
      ? Effect.tryPromise({
          try: async () =>
            keyring === null
              ? null
              : ((await keyring(KEYCHAIN_SERVICE, accountId).getPassword()) ?? null),
          catch: (cause) => new MailCredentialError({ accountId, operation: "read", cause }),
        })
      : secrets.get(secretName(accountId)).pipe(
          Effect.map(
            Option.match({
              onNone: () => null,
              onSome: (bytes) => new TextDecoder().decode(bytes),
            }),
          ),
          Effect.mapError(
            (cause) => new MailCredentialError({ accountId, operation: "read", cause }),
          ),
        );

  const remove: MailCredentials["Service"]["remove"] = (accountId, store) =>
    store === "keychain"
      ? Effect.tryPromise({
          try: async () => {
            if (keyring !== null) await keyring(KEYCHAIN_SERVICE, accountId).deletePassword();
          },
          catch: (cause) => new MailCredentialError({ accountId, operation: "remove", cause }),
        })
      : secrets
          .remove(secretName(accountId))
          .pipe(
            Effect.mapError(
              (cause) => new MailCredentialError({ accountId, operation: "remove", cause }),
            ),
          );

  return MailCredentials.of({ put, get, remove });
});

export const layer = Layer.effect(MailCredentials, make);

/** In-memory credentials for tests. */
export const layerMemory = Layer.sync(MailCredentials, () => {
  const values = new Map<string, string>();
  return MailCredentials.of({
    put: Effect.fn("MailCredentials.put")((accountId, password) =>
      Effect.sync(() => {
        values.set(accountId, password);
        return "file" as const;
      }),
    ),
    get: Effect.fn("MailCredentials.get")((accountId) =>
      Effect.sync(() => values.get(accountId) ?? null),
    ),
    remove: Effect.fn("MailCredentials.remove")((accountId) =>
      Effect.sync(() => {
        values.delete(accountId);
      }),
    ),
  });
});
