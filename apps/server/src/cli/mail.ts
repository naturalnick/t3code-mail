import { MailDraftId, MailSettleReason, MailThreadId, MailThreadState } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import {
  jsonFlag,
  printJson,
  reportThreadErrors,
  ThreadUsageError,
  withThreadTools,
  type ThreadTools,
} from "./thread.ts";

const client = { label: "t3 mail cli", clientName: "t3-mail-cli" };

const Row = Schema.Struct({
  threadId: MailThreadId,
  from: Schema.String,
  subject: Schema.String,
  line: Schema.String,
  state: MailThreadState,
  lastMessageAt: Schema.String,
  unread: Schema.Boolean,
  suggestedSettle: Schema.optionalKey(MailSettleReason),
  hasDraft: Schema.Boolean,
});
const ListResult = Schema.Struct({ threads: Schema.Array(Row) });
const ReadResult = Schema.Struct({
  subject: Schema.String,
  state: MailThreadState,
  messages: Schema.Array(
    Schema.Struct({
      from: Schema.String,
      date: Schema.String,
      fromUser: Schema.Boolean,
      text: Schema.String,
      attachments: Schema.Array(Schema.String),
    }),
  ),
  drafts: Schema.Array(
    Schema.Struct({
      draftId: MailDraftId,
      revision: Schema.Int,
      body: Schema.String,
      status: Schema.String,
    }),
  ),
});
const DraftResult = Schema.Struct({ draftId: MailDraftId, revision: Schema.Int });
const TriageResult = Schema.Struct({ changed: Schema.Int });

const threadIdsArgument = Argument.String("thread-id").pipe(
  Argument.withDescription("Mail thread id, as `t3 mail list` prints it."),
  Argument.variadic({ min: 1 }),
);

const withMailTools = <A, E, R>(
  flags: { readonly baseDir: Option.Option<string>; readonly json: boolean },
  run: (tools: ThreadTools) => Effect.Effect<A, E, R>,
) => withThreadTools(flags, run, client).pipe(reportThreadErrors);

const printRows = (rows: ReadonlyArray<typeof Row.Type>) =>
  Effect.forEach(rows, (row) =>
    Console.log(
      `${row.threadId}  ${row.state.padEnd(7)}  ${row.from.slice(0, 28).padEnd(28)}  ${row.line}${row.suggestedSettle ? `  [settle? ${row.suggestedSettle}]` : ""}`,
    ),
  );

const listCommand = Command.make("list", {
  ...projectLocationFlags,
  state: Flag.Literals("state", ["active", "working", "snoozed", "settled"] as const).pipe(
    Flag.withDescription("Sidebar section to list."),
    Flag.withDefault("active" as const),
  ),
  search: Flag.String("search").pipe(
    Flag.withDescription("Search all mail instead."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List email threads, Active by default."),
  Command.withHandler((flags) =>
    withMailTools(
      flags,
      Effect.fn("cli.mail.list")(function* (tools) {
        const result = yield* tools.call(
          "t3_mail_list",
          Option.match(flags.search, {
            onNone: () => ({ state: flags.state, limit: 100 }),
            onSome: (query) => ({ query, limit: 100 }),
          }),
          ListResult,
        );
        if (flags.json) return yield* printJson(result.threads);
        yield* printRows(result.threads);
      }),
    ),
  ),
);

const showCommand = Command.make("show", {
  ...projectLocationFlags,
  threadId: Argument.String("thread-id"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Print one email thread as text."),
  Command.withHandler((flags) =>
    withMailTools(
      flags,
      Effect.fn("cli.mail.show")(function* (tools) {
        const result = yield* tools.call("t3_mail_read", { threadId: flags.threadId }, ReadResult);
        if (flags.json) return yield* printJson(result);
        yield* Console.log(`${result.subject} (${result.state})`);
        for (const message of result.messages) {
          yield* Console.log(`\n${message.fromUser ? "You" : message.from}  ${message.date}`);
          yield* Console.log(message.text);
          if (message.attachments.length > 0) {
            yield* Console.log(`Attachments: ${message.attachments.join(", ")}`);
          }
        }
        for (const draft of result.drafts) {
          yield* Console.log(
            `\nDraft ${draft.draftId} (revision ${draft.revision}, ${draft.status}):\n${draft.body}`,
          );
        }
      }),
    ),
  ),
);

const draftCommand = Command.make("draft", {
  ...projectLocationFlags,
  threadId: Argument.String("thread-id"),
  body: Argument.String("body").pipe(Argument.withDescription("The reply text, or - for stdin.")),
  draftId: Flag.String("draft-id").pipe(
    Flag.withDescription("Revise this draft instead of starting one."),
    Flag.optional,
  ),
  expectedRevision: Flag.Int("expected-revision").pipe(
    Flag.withDescription("Revision shown by mail show for the draft being edited."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Leave a reply draft for review in Mail. It is never sent from here."),
  Command.withHandler((flags) =>
    withMailTools(
      flags,
      Effect.fn("cli.mail.draft")(function* (tools) {
        const body =
          flags.body === "-"
            ? yield* Stdio.Stdio.pipe(
                Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
              )
            : flags.body;
        if (body.trim().length === 0) {
          return yield* new ThreadUsageError({ detail: "The draft is empty." });
        }
        if (Option.isSome(flags.draftId) !== Option.isSome(flags.expectedRevision)) {
          return yield* new ThreadUsageError({
            detail: "Use --draft-id and --expected-revision together.",
          });
        }
        const result = yield* tools.call(
          "t3_mail_draft",
          {
            threadId: flags.threadId,
            body,
            ...(Option.isSome(flags.expectedRevision)
              ? { expectedRevision: flags.expectedRevision.value }
              : {}),
            ...Option.match(flags.draftId, {
              onNone: () => ({}),
              onSome: (draftId) => ({ draftId }),
            }),
          },
          DraftResult,
        );
        yield* flags.json ? printJson(result) : Console.log(result.draftId);
      }),
    ),
  ),
);

const triageCommand = (name: "propose" | "activate") =>
  Command.make(name, {
    ...projectLocationFlags,
    threadIds: threadIdsArgument,
    reason: Flag.Literals("reason", ["fyi", "receipt", "noise", "done"] as const).pipe(
      Flag.withDescription("Why the thread can settle."),
      Flag.withDefault("fyi" as const),
    ),
    json: jsonFlag,
  }).pipe(
    Command.withDescription(
      name === "propose"
        ? "Propose settling threads; they settle when you approve in Mail."
        : "Move threads back to Active.",
    ),
    Command.withHandler((flags) =>
      withMailTools(
        flags,
        Effect.fn("cli.mail.triage")(function* (tools) {
          const result = yield* tools.call(
            "t3_mail_triage",
            {
              threadIds: flags.threadIds,
              action: name === "propose" ? "propose_settle" : "return_to_active",
              reason: flags.reason,
            },
            TriageResult,
          );
          yield* flags.json ? printJson(result) : Console.log(`Changed ${result.changed}.`);
        }),
      ),
    ),
  );

export const mailCommand = Command.make("mail").pipe(
  Command.withDescription("Read mail and leave drafts or settle proposals on the running server."),
  Command.withSubcommands([
    listCommand,
    showCommand,
    draftCommand,
    triageCommand("propose"),
    triageCommand("activate"),
  ]),
);
