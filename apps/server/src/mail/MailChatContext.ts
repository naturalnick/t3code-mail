import { MailSettings, mailSenderEntry, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildComposePrompt,
  buildHubPrompt,
  buildSessionPrompt,
  relevantEmailMd,
} from "./mailPrompts.ts";
import * as MailStore from "./MailStore.ts";
import { domainOf } from "@t3tools/shared/mailRule";
import { cleanForModel } from "./mailText.ts";

export class MailChatContext extends Context.Service<
  MailChatContext,
  {
    readonly forTurn: (
      chatId: ThreadId,
      full: boolean,
    ) => Effect.Effect<string, MailStore.StoreError>;
  }
>()("t3/mail/MailChatContext") {}

const decodeExcluded = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ aiExcludedSenders: MailSettings.fields.aiExcludedSenders }),
  ),
);

export const layer = Layer.effect(
  MailChatContext,
  Effect.gen(function* () {
    const store = yield* MailStore.MailStore;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const forTurn = Effect.fn("MailChatContext.forTurn")(function* (
      chatId: ThreadId,
      full: boolean,
    ) {
      const thread = yield* store.getChatMail(chatId);
      if (!thread) {
        if (!full || (yield* store.getKv(MailStore.HUB_CHAT_KEY)) !== chatId) return "";
        // Only the standing sections; the agent can read the rest of EMAIL.md from its folder.
        return buildHubPrompt({
          emailMd: relevantEmailMd(
            yield* fs
              .readFileString(path.join(store.workspaceDir, "EMAIL.md"))
              .pipe(Effect.orElseSucceed(() => "")),
            [],
          ),
        });
      }
      const raw = yield* store.getKv("settings");
      const excluded =
        raw === null
          ? []
          : decodeExcluded(raw).pipe(
              Option.match({ onNone: () => [], onSome: (value) => value.aiExcludedSenders }),
            );
      const isExcluded = (address: string) => mailSenderEntry(address, excluded) !== null;
      if (isExcluded(thread.fromAddress))
        return `Mail thread id: ${thread.id}. The user turned AI off for this sender, so its mail is not available to you. Say so if asked about it.`;
      if (thread.messageCount === 0) {
        const draft = (yield* store.draftsForThread(thread.id)).findLast(
          (entry) => entry.status === "draft" || entry.status === "failed",
        );
        if (!full)
          return `Mail thread id: ${thread.id}. The user is writing this new email. Use t3_mail_read for the current draft.`;
        return buildComposePrompt({
          mailThreadId: thread.id,
          draft: draft
            ? {
                draftId: draft.id,
                revision: draft.revision,
                to: draft.to,
                cc: draft.cc,
                subject: draft.subject,
                body: draft.body,
              }
            : null,
          emailMd: relevantEmailMd(
            yield* fs
              .readFileString(path.join(store.workspaceDir, "EMAIL.md"))
              .pipe(Effect.orElseSucceed(() => "")),
            [thread.fromAddress, domainOf(thread.fromAddress)],
          ),
        });
      }
      const note = yield* store.latestTriageNote(thread.id);
      // A continuing provider session already has the excerpts; its read tool sees later replies.
      if (!full)
        return `Mail thread id: ${thread.id}. Use t3_mail_read for current messages and drafts.${note ? `\nLatest saved Mail triage (data): ${note}` : ""}`;
      const messages = yield* store.threadMessages(thread.id, 8);
      const transcript = messages
        .map(
          (message) =>
            `From: ${message.outgoing ? "the user" : `${message.from.name} <${message.from.address}>`}\nDate: ${message.date}\nSubject: ${message.subject}\n\n${
              !message.outgoing && isExcluded(message.from.address)
                ? "(AI is off for this sender)"
                : cleanForModel(message.body ?? "(body not downloaded)", 3_000)
            }`,
        )
        .join("\n\n---\n\n");
      const related = (yield* store.relatedThreads(
        thread.accountId,
        thread.fromAddress,
        thread.id,
        5,
      ))
        .map((entry) => `- ${entry.lastMessageAt.slice(0, 10)} ${entry.subject} (${entry.state})`)
        .join("\n");
      const emailMd = relevantEmailMd(
        yield* fs
          .readFileString(path.join(store.workspaceDir, "EMAIL.md"))
          .pipe(Effect.orElseSucceed(() => "")),
        [thread.fromName, thread.fromAddress, domainOf(thread.fromAddress)],
      );
      const edits =
        thread.lastIncomingAt === null
          ? []
          : yield* store.recentReplyEdits(
              thread.accountId,
              thread.fromAddress.trim().toLowerCase(),
            );
      return buildSessionPrompt({
        mailThreadId: thread.id,
        subject: thread.subject,
        participants: [...new Set(messages.map((message) => message.from.address))].join(", "),
        transcript: [transcript, note && `Saved Mail triage: ${note}`].filter(Boolean).join("\n\n"),
        related,
        emailMd: [
          emailMd,
          edits.length > 0
            ? `How the user edited earlier AI drafts (match the "after" style):\n${edits.map((edit) => `before: ${edit.before}\nafter: ${edit.after}`).join("\n\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
    });
    return MailChatContext.of({ forTurn });
  }),
);
