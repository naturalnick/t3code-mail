import * as EventSink from "../src/orchestration-v2/EventSink.ts";
// @effect-diagnostics nodeBuiltinImport:off -- assertions and output for the Docker fixture.
import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as HostPowerMonitor from "../src/background/HostPowerMonitor.ts";
import * as MailCredentials from "../src/mail/MailCredentials.ts";
import * as MailEngine from "../src/mail/MailEngine.ts";
import * as MailService from "../src/mail/MailService.ts";
import * as MailStore from "../src/mail/MailStore.ts";
import * as MailSync from "../src/mail/MailSync.ts";
import * as ThreadLaunchService from "../src/orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../src/orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../src/persistence/Sqlite.ts";
import * as ProjectService from "../src/project/ProjectService.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import * as TextGeneration from "../src/textGeneration/TextGeneration.ts";
import type { MailAccount } from "@t3tools/contracts";

export async function verifyGreenMail(input: {
  readonly email: string;
  readonly password: string;
  readonly imaps: number;
  readonly smtps: number;
  readonly seededMessages: number;
  readonly deliver: (subject: string) => Promise<void>;
  readonly verifyCopies: (subject: string) => Promise<void>;
}) {
  const check = Effect.gen(function* () {
    const mail = yield* MailService.MailService;
    const power = yield* HostPowerMonitor.HostPowerMonitor;
    const store = yield* MailStore.MailStore;
    const reportSuspend = Effect.fn("verifyGreenMail.reportSuspend")(function* (
      suspended: boolean,
    ) {
      yield* power.report({
        ...(yield* power.snapshot),
        source: "electron-main",
        stale: false,
        suspended,
        updatedAt: yield* DateTime.now,
      });
    });
    const account = yield* mail.addAccount({
      email: input.email,
      appPassword: input.password,
      connection: {
        imapHost: "127.0.0.1",
        imapPort: input.imaps,
        imapTls: true,
        smtpHost: "127.0.0.1",
        smtpPort: input.smtps,
        smtpTls: true,
        username: input.email,
      },
    });
    const waitFor = (accept: (value: MailAccount) => boolean) =>
      mail.subscribe.pipe(
        Stream.filter((event) => {
          if (event.type === "threads") return false;
          const current = event.status.accounts.find((value) => value.id === account.id);
          if (!current) return false;
          if (["error", "auth_failed", "offline"].includes(current.status)) {
            throw new Error(`${current.status}: ${current.statusDetail}`);
          }
          return accept(current);
        }),
        Stream.runHead,
        Effect.timeout("30 seconds"),
      );
    yield* waitFor(
      (value) => value.status === "idle" && value.messageCount === input.seededMessages,
    );
    const [incoming] = (yield* mail.search({ query: '"Could we do Friday"' })).threads;
    const [sent] = (yield* mail.search({ query: '"Tuesday works"' })).threads;
    NodeAssert.ok(incoming && sent);
    NodeAssert.equal((yield* mail.getThread(sent.id)).messages[0]?.outgoing, true);
    yield* Effect.log(
      `IMAPS synced ${input.seededMessages} seeded messages from INBOX and Sent; exact phrase search found their bodies.`,
    );

    yield* Effect.promise(() => input.deliver("Live IDLE delivery"));
    yield* waitFor(
      (value) => value.status === "idle" && value.messageCount === input.seededMessages + 1,
    );
    NodeAssert.equal((yield* mail.search({ query: '"Live IDLE delivery"' })).threads.length, 1);
    yield* Effect.log("New mail arrived without a manual sync.");

    const draft = yield* mail.saveDraft(
      {
        threadId: incoming.id,
        to: [input.email],
        cc: [],
        subject: "Re: GreenMail receipt",
        body: "This is the approved GreenMail reply.",
      },
      { actor: "user" },
    );
    const approved = yield* mail.sendDraft({ draftId: draft.id, revision: draft.revision });
    NodeAssert.equal(approved.status, "sent", approved.error ?? undefined);
    yield* waitFor(
      (value) => value.status === "idle" && value.messageCount >= input.seededMessages + 2,
    );
    NodeAssert.ok((yield* mail.search({ query: '"approved GreenMail reply"' })).threads.length);
    yield* Effect.log(
      "SMTPS delivered the approved revision to the fake inbox and sync indexed the reply.",
    );
    yield* reportSuspend(true);
    yield* waitFor((value) => value.status === "paused");
    const beforeReset = yield* store.getMailbox(account.id, "INBOX");
    NodeAssert.ok(beforeReset);
    yield* mail.act({ threadIds: [incoming.id], action: { type: "pin" } }, { actor: "user" });
    // Give the local cache a previous UIDVALIDITY so reconnect exercises the production reset path.
    yield* store.putMailbox({
      ...beforeReset,
      uidValidity: String(BigInt(beforeReset.uidValidity) + 1n),
    });
    yield* Effect.promise(() => input.deliver("Delivered during sleep"));
    yield* reportSuspend(false);
    yield* waitFor(
      (value) => value.status === "idle" && value.messageCount >= input.seededMessages + 3,
    );
    NodeAssert.equal((yield* mail.search({ query: '"Delivered during sleep"' })).threads.length, 1);
    NodeAssert.equal(
      (yield* store.getMailbox(account.id, "INBOX"))?.uidValidity,
      beforeReset.uidValidity,
    );
    NodeAssert.ok((yield* mail.getThread(incoming.id)).thread.pinnedAt);
    yield* Effect.promise(() => input.verifyCopies(draft.subject));
    yield* Effect.log(
      "Wake rebuilt a stale UIDVALIDITY cursor, preserved the pin, and confirmed the approved reply in INBOX and Sent.",
    );
    yield* mail.updateSettings({ syncEnabled: false });
    yield* reportSuspend(true);
    yield* reportSuspend(false);
    yield* waitFor((value) => value.status === "paused");
    yield* Effect.log(
      "Desktop suspend paused sync, resume indexed mail delivered during sleep, and disabling sync kept the account paused.",
    );
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mail-verify-" });
      yield* check.pipe(
        Effect.provide(
          MailService.layer.pipe(
            Layer.provide(Layer.mock(EventSink.EventSinkV2)({})),
            Layer.provide(MailSync.layer),
            Layer.provide(MailEngine.layer),
            Layer.provide(MailCredentials.layerMemory),
            Layer.provideMerge(MailStore.layerMemory(dir)),
            Layer.provide(Sqlite.layerMemory),
            Layer.provide(Layer.mock(TextGeneration.TextGeneration)({})),
            Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
            Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
            Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
            Layer.provide(Layer.mock(ServerSettings.ServerSettingsService)({})),
            Layer.provide(SecureRandom.layerWebCrypto),
          ),
        ),
        Effect.provideServiceEffect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make()),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
