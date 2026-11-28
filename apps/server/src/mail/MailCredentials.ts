// @effect-diagnostics nodeBuiltinImport:off - the keychain binding is a CommonJS native module loaded on demand.
import * as NodeModule from "node:module";

import { MailAccountId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

// Saved passwords are keyed by this name; renaming it orphans every stored account password.
const KEYCHAIN_SERVICE = "T3 Code Mail";

export class MailCredentialError extends Schema.TaggedError<MailCredentialError>()(
  "MailCredentialError",
  {
    accountId: MailAccountId,
    backend: Schema.Literals(["keychain", "file"]),
    operation: Schema.Literals(["read", "write", "remove"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the app password in the ${this.backend === "keychain" ? "keychain" : "local secrets folder"}.`;
  }
}

export type CredentialStore = "keychain" | "file";

export class MailCredentials extends Context.Service<
  MailCredentials,
  {
    readonly preferredStore: (accountId: MailAccountId) => Effect.Effect<CredentialStore>;
    /** A failed keychain write may leave a copy even when fallback to the file succeeds. */
    readonly put: (
      accountId: MailAccountId,
      password: string,
      preferred: CredentialStore,
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

const make = Effect.fn("MailCredentials.make")(function* (keyring: ReturnType<typeof loadKeyring>) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;

  const preferredStore: MailCredentials["Service"]["preferredStore"] = (accountId) =>
    keyring === null
      ? Effect.succeed("file")
      : Effect.tryPromise({
          try: () => keyring(KEYCHAIN_SERVICE, accountId).getPassword(),
          catch: (cause) =>
            new MailCredentialError({ accountId, backend: "keychain", operation: "read", cause }),
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.as("keychain" as const),
          Effect.orElseSucceed(() => "file" as const),
        );

  const put: MailCredentials["Service"]["put"] = Effect.fn("MailCredentials.put")(
    function* (accountId, password, preferred) {
      if (preferred === "keychain" && keyring !== null) {
        const stored = yield* Effect.tryPromise({
          try: async () => {
            const entry = keyring(KEYCHAIN_SERVICE, accountId);
            await entry.setPassword(password);
            return (await entry.getPassword()) === password;
          },
          catch: (cause) =>
            new MailCredentialError({
              accountId,
              backend: "keychain",
              operation: "write",
              cause,
            }),
        }).pipe(Effect.orElseSucceed(() => false));
        if (stored) return "keychain" as const;
      }
      yield* secrets
        .set(secretName(accountId), new TextEncoder().encode(password))
        .pipe(
          Effect.mapError(
            (cause) =>
              new MailCredentialError({ accountId, backend: "file", operation: "write", cause }),
          ),
        );
      return "file" as const;
    },
  );

  const get: MailCredentials["Service"]["get"] = (accountId, store) =>
    store === "keychain"
      ? Effect.tryPromise({
          try: async () => {
            if (keyring === null) throw new Error("Keychain unavailable");
            return (await keyring(KEYCHAIN_SERVICE, accountId).getPassword()) ?? null;
          },
          catch: (cause) =>
            new MailCredentialError({ accountId, backend: "keychain", operation: "read", cause }),
        })
      : secrets.get(secretName(accountId)).pipe(
          Effect.map(
            Option.match({
              onNone: () => null,
              onSome: (bytes) => new TextDecoder().decode(bytes),
            }),
          ),
          Effect.mapError(
            (cause) =>
              new MailCredentialError({ accountId, backend: "file", operation: "read", cause }),
          ),
        );

  const remove: MailCredentials["Service"]["remove"] = (accountId, store) =>
    store === "keychain"
      ? Effect.tryPromise({
          try: async () => {
            if (keyring === null) throw new Error("Keychain unavailable");
            const entry = keyring(KEYCHAIN_SERVICE, accountId);
            if ((await entry.getPassword()) == null) return;
            await entry.deletePassword();
            if ((await entry.getPassword()) != null) throw new Error("Keychain entry still exists");
          },
          catch: (cause) =>
            new MailCredentialError({
              accountId,
              backend: "keychain",
              operation: "remove",
              cause,
            }),
        })
      : secrets.remove(secretName(accountId)).pipe(
          Effect.mapError(
            (cause) =>
              new MailCredentialError({
                accountId,
                backend: "file",
                operation: "remove",
                cause,
              }),
          ),
        );

  return MailCredentials.of({ preferredStore, put, get, remove });
});

export const layerWithKeyring = (keyring: ReturnType<typeof loadKeyring>) =>
  Layer.effect(MailCredentials, make(keyring));

export const layer = Layer.suspend(() => layerWithKeyring(loadKeyring()));

/** In-memory credentials for tests. */
export const layerMemory = Layer.sync(MailCredentials, () => {
  const values = new Map<string, string>();
  return MailCredentials.of({
    preferredStore: Effect.fn("MailCredentials.preferredStore")(() =>
      Effect.succeed("file" as const),
    ),
    put: Effect.fn("MailCredentials.put")((accountId, password) =>
      Effect.sync(() => {
        values.set(accountId, password);
        return "file" as const;
      }),
    ),
    get: Effect.fn("MailCredentials.get")((accountId, store) =>
      Effect.sync(() => (store === "file" ? (values.get(accountId) ?? null) : null)),
    ),
    remove: Effect.fn("MailCredentials.remove")((accountId, store) =>
      Effect.sync(() => {
        if (store === "file") values.delete(accountId);
      }),
    ),
  });
});
