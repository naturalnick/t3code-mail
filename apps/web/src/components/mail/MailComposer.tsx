import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MailDraft, MailMessage, MailThreadDetail } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { useGT } from "gt-react";
import {
  ChevronDownIcon,
  ForwardIcon,
  PaperclipIcon,
  ReplyAllIcon,
  ReplyIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { mailEnvironment } from "../../state/mail";
import { formatDateTimeTimestamp } from "../../timestampFormat";
import { useMailCommand } from "../settings/MailSettings.commands";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { QuotedToggle } from "./MailFormattedMessage";
import {
  type ComposeMode,
  composeRecipients,
  composeSubject,
  hasOtherRecipients,
} from "./mailCompose.logic";
import { parseRecipients } from "./mailPresentation";

export interface ComposeTask {
  readonly mode: ComposeMode;
  readonly targetId: string;
  readonly draft: MailDraft | null;
}

interface Fields {
  readonly to: string;
  readonly cc: string;
  readonly subject: string;
  readonly body: string;
}

const MODE_ICONS = { reply: ReplyIcon, replyAll: ReplyAllIcon, forward: ForwardIcon } as const;

function display(entry: { name: string; address: string }) {
  return entry.name && entry.name !== entry.address
    ? `${entry.name} <${entry.address}>`
    : entry.address;
}

/**
 * A reply or forward written under the message it answers, so the email and its chat stay in view.
 * It says which message it answers and shows what is sent with it.
 */
export function MailComposer({
  environmentId,
  detail,
  target,
  mine,
  from,
  timestampFormat,
  refresh,
  task,
  onSaved,
  close,
}: {
  environmentId: EnvironmentId;
  detail: MailThreadDetail;
  target: MailMessage;
  mine: ReadonlyArray<string>;
  from: string;
  timestampFormat: TimestampFormat;
  refresh: () => void;
  task: ComposeTask;
  onSaved: (draft: MailDraft) => void;
  close: () => void;
}) {
  const gt = useGT();
  const formId = useId();
  const form = useRef<HTMLFormElement | null>(null);
  const save = useMailCommand(environmentId, mailEnvironment.saveDraft, gt("Could not save draft"));
  const send = useMailCommand(environmentId, mailEnvironment.sendDraft, gt("Could not send email"));
  const discard = useMailCommand(
    environmentId,
    mailEnvironment.discardDraft,
    gt("Could not discard draft"),
  );
  const canSend = useAtomValue(mailEnvironment.sendDraft.permissionAtom(environmentId));
  const baseSubject = target.subject || detail.thread.subject;
  const defaults = (mode: ComposeMode): Fields => {
    const recipients = composeRecipients(mode, target, mine);
    return {
      to: recipients.to.join(", "),
      cc: recipients.cc.join(", "),
      subject: composeSubject(mode, baseSubject),
      body: "",
    };
  };
  const initialDraft = task.draft;
  // Drafts saved before targets existed already hold any quote in their text and send as written.
  const legacy = initialDraft !== null && initialDraft.targetMessageId === null;
  const replyAll = hasOtherRecipients(target, mine);
  const [mode, setMode] = useState<ComposeMode>(task.mode);
  const [fields, setFields] = useState<Fields>(() =>
    initialDraft
      ? {
          to: initialDraft.to.join(", "),
          cc: initialDraft.cc.join(", "),
          subject: initialDraft.subject,
          body: initialDraft.body,
        }
      : defaults(task.mode),
  );
  // The last saved copy; saving replaces it, another client's edit makes it stale.
  const [draft, setDraft] = useState(initialDraft);
  const [savedFields, setSavedFields] = useState(fields);
  const [showCc, setShowCc] = useState(fields.cc.length > 0);
  const [showQuoted, setShowQuoted] = useState(false);
  const latest = draft && detail.drafts.find((item) => item.id === draft.id);
  const stale = draft !== null && (!latest || latest.revision !== draft.revision);
  const pending = save.pending || send.pending || discard.pending;
  const forward = mode === "forward";
  const dirty =
    fields.to !== savedFields.to ||
    fields.cc !== savedFields.cc ||
    fields.subject !== savedFields.subject ||
    fields.body !== savedFields.body ||
    (draft !== null && (draft.mode === "forward") !== forward) ||
    (draft !== null && !legacy && draft.targetMessageId !== target.id);
  const showSubject = forward || fields.subject !== composeSubject("reply", baseSubject);
  const failed = latest?.status === "failed" ? latest.error : null;
  const sender = target.from.name || target.from.address;
  const when = formatDateTimeTimestamp(target.date, timestampFormat);
  const ModeIcon = MODE_ICONS[mode];
  const modeLabel =
    mode === "forward" ? gt("Forward") : mode === "replyAll" ? gt("Reply all") : gt("Reply");

  const mounted = useRef(true);
  /** `asCopy` keeps the user's text as a new draft when the open one changed elsewhere. */
  const persist = async (values: Fields, asCopy = false) => {
    const result = await save.run({
      threadId: detail.thread.id,
      ...(draft && !asCopy ? { draftId: draft.id, expectedRevision: draft.revision } : {}),
      to: parseRecipients(values.to),
      cc: parseRecipients(values.cc),
      subject: values.subject,
      body: values.body,
      mode: forward ? "forward" : "reply",
      targetMessageId: legacy ? null : target.id,
    });
    refresh();
    if (!result) return null;
    setDraft(result.value);
    setSavedFields(values);
    if (mounted.current) onSaved(result.value);
    return result.value;
  };

  // Leaving with unsaved text (another email, another reply) keeps it as a draft, like Gmail.
  const finished = useRef(false);
  const saveOnLeave = useEffectEvent(() => {
    if (!finished.current && dirty && !pending) void persist(fields, stale);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Saves unsent text when the editor unmounts.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      saveOnLeave();
    };
  }, []);

  const switchMode = (next: ComposeMode) => {
    if (next === mode) return;
    const base = defaults(next);
    setMode(next);
    setFields({ ...base, body: fields.body });
    setShowCc(base.cc.length > 0);
  };
  const set = (key: keyof Fields) => (value: string) => setFields({ ...fields, [key]: value });
  const finish = () => {
    finished.current = true;
    // A slow save or send must not close the editor the user has since opened elsewhere.
    if (mounted.current) close();
  };

  const field = (key: "to" | "cc" | "subject", label: string, autoFocus = false) => (
    <div className="flex items-center gap-2 border-b border-border/70 px-3">
      <label htmlFor={`${formId}-${key}`} className="w-14 shrink-0 text-muted-foreground">
        {label}
      </label>
      <Input
        id={`${formId}-${key}`}
        name={key}
        unstyled
        className="min-w-0 flex-1"
        value={fields[key]}
        onValueChange={set(key)}
        autoFocus={autoFocus}
      />
      {key === "to" && !showCc ? (
        <Button type="button" size="xs" variant="ghost-muted" onClick={() => setShowCc(true)}>
          {gt("Cc")}
        </Button>
      ) : null}
    </div>
  );

  return (
    <form
      id={formId}
      ref={(node) => {
        form.current = node;
        node?.scrollIntoView({ block: "nearest" });
      }}
      aria-label={modeLabel}
      className="my-3 overflow-hidden rounded-xl border border-border bg-background shadow-xs"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending || stale) return;
        if (parseRecipients(fields.to).length + parseRecipients(fields.cc).length === 0) {
          form.current?.querySelector<HTMLInputElement>("input[name=to]")?.focus();
          return;
        }
        const saved = draft && !dirty ? draft : await persist(fields);
        if (!saved) return;
        const result = await send.run({ draftId: saved.id, revision: saved.revision });
        refresh();
        if (result) finish();
      }}
    >
      <div className="flex items-center gap-1 border-b border-border/70 py-1 pr-1 pl-1.5">
        <Menu>
          <MenuTrigger
            disabled={pending}
            render={
              <Button type="button" size="xs" variant="ghost" aria-label={gt("Reply type")} />
            }
          >
            <ModeIcon />
            {modeLabel}
            <ChevronDownIcon className="opacity-60" />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuItem onClick={() => switchMode("reply")}>
              <ReplyIcon />
              {gt("Reply")}
            </MenuItem>
            {replyAll || mode === "replyAll" ? (
              <MenuItem onClick={() => switchMode("replyAll")}>
                <ReplyAllIcon />
                {gt("Reply all")}
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => switchMode("forward")}>
              <ForwardIcon />
              {gt("Forward")}
            </MenuItem>
          </MenuPopup>
        </Menu>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {forward
            ? target.outgoing
              ? gt("Forwarding your message from {date}", { date: when })
              : gt("Forwarding {sender}’s message from {date}", { sender, date: when })
            : target.outgoing
              ? gt("Replying to your message from {date}", { date: when })
              : gt("Replying to {sender}’s message from {date}", { sender, date: when })}
        </p>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-label={dirty ? gt("Close and keep draft") : gt("Close")}
          onClick={async () => {
            if (!dirty || (await persist(fields, stale))) finish();
          }}
        >
          <XIcon />
        </Button>
      </div>
      <fieldset disabled={pending} className="text-sm">
        {field("to", gt("To"), forward)}
        {showCc ? field("cc", gt("Cc")) : null}
        {showSubject ? field("subject", gt("Subject")) : null}
        <Textarea
          name="body"
          aria-label={gt("Message")}
          unstyled
          rows={6}
          value={fields.body}
          onChange={(event) => set("body")(event.currentTarget.value)}
          autoFocus={!forward}
        />
      </fieldset>
      <div className="px-3 pb-2">
        {forward && !legacy ? (
          <div className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{gt("Forwarded message")}</p>
            <p className="truncate">
              {gt("From: {sender}", { sender: display(target.from) })} · {when}
            </p>
            {target.attachments.length > 0 ? (
              <ul
                aria-label={gt("Attachments sent with this forward")}
                className="mt-1.5 flex flex-wrap gap-1.5"
              >
                {target.attachments.map((file, index) => (
                  <li
                    // oxlint-disable-next-line react/no-array-index-key -- MIME parts have fixed order and can share identical metadata.
                    key={index}
                    className="inline-flex items-center gap-1 rounded-md bg-background px-1.5 py-0.5"
                  >
                    <PaperclipIcon aria-hidden className="size-3" />
                    {file.filename || file.contentType} · {formatBytes(file.size)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {legacy ? null : (
          <QuotedToggle shown={showQuoted} onToggle={() => setShowQuoted(!showQuoted)} />
        )}
        {showQuoted && !legacy ? (
          <div className="mt-2 border-l-2 border-border pl-3 text-xs text-muted-foreground">
            <p className="mb-1">
              {forward
                ? gt("Sent below your message:")
                : gt("On {date}, {sender} wrote:", { date: when, sender: display(target.from) })}
            </p>
            <p className="whitespace-pre-wrap wrap-anywhere">
              {target.fullText ?? target.text ?? gt("Message body unavailable.")}
            </p>
          </div>
        ) : null}
      </div>
      {stale || failed ? (
        <p role="alert" className="px-3 pb-2 text-sm text-warning-foreground">
          {stale
            ? gt("This draft changed elsewhere. Saving keeps your version as a separate draft.")
            : failed}
        </p>
      ) : null}
      <div className="flex items-center gap-2 px-3 pb-3">
        {canSend ? (
          <Button type="submit" size="sm" disabled={pending || stale}>
            <SendIcon />
            {gt("Send")}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || (!dirty && draft !== null)}
          onClick={async () => {
            if (await persist(fields, stale)) finish();
          }}
        >
          {gt("Save draft")}
        </Button>
        {from ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {gt("From: {sender}", { sender: from })}
          </span>
        ) : null}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost-muted"
          className="ml-auto"
          aria-label={gt("Discard draft")}
          disabled={pending}
          onClick={async () => {
            if (!draft) return finish();
            const result = await discard.run({
              draftId: draft.id,
              expectedRevision: draft.revision,
            });
            refresh();
            if (result) finish();
          }}
        >
          <Trash2Icon />
        </Button>
      </div>
    </form>
  );
}
