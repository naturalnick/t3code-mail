import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { buildSessionPrompt, relevantEmailMd } from "./mailPrompts.ts";
import * as MailStore from "./MailStore.ts";
import { cleanForModel, domainOf } from "./mailText.ts";

export class MailChatContext extends Context.Service<
  MailChatContext,
  {
    readonly forTurn: (
      chatId: ThreadId,
      full: boolean,
    ) => Effect.Effect<string, MailStore.StoreError>;
  }
>()("t3/mail/MailChatContext") {}

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
      if (!thread) return "";
      const note = yield* store.latestTriageNote(thread.id);
      // A continuing provider session already has the excerpts; its read tool sees later replies.
      if (!full)
        return `Mail thread id: ${thread.id}. Use t3_mail_read for current messages and drafts.${note ? `\nLatest saved Mail triage (data): ${note}` : ""}`;
      const messages = yield* store.threadMessages(thread.id, 8);
      const transcript = messages
        .map(
          (message) =>
            `From: ${message.outgoing ? "the user" : `${message.from.name} <${message.from.address}>`}\nDate: ${message.date}\nSubject: ${message.subject}\n\n${cleanForModel(message.body ?? "(body not downloaded)", 3_000)}`,
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
