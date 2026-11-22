import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MailDraft, MailThreadDetail } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { useGT } from "gt-react";
import { SendIcon, Trash2Icon, XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { mailEnvironment } from "../../state/mail";
import { formatDateTimeTimestamp } from "../../timestampFormat";
import { useMailCommand } from "../settings/MailSettings.commands";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { forwardSubject, parseRecipients, replySubject } from "./mailPresentation";

export interface ComposeTask {
  readonly mode: "reply" | "forward";
  readonly draft: MailDraft | null;
}

function address(entry: { name: string | null; address: string }) {
  return entry.name && entry.name !== entry.address
    ? `${entry.name} <${entry.address}>`
    : entry.address;
}

/** Plain-text forward of the newest message, in the layout mail clients recognize. */
function forwardBody(
  detail: MailThreadDetail,
  timestampFormat: TimestampFormat,
  gt: ReturnType<typeof useGT>,
) {
  const last = detail.messages.at(-1);
  if (!last) return "";
  const lines = [
    "",
    "",
    gt("---------- Forwarded message ---------"),
    gt("From: {sender}", { sender: address(last.from) }),
    gt("Date: {date}", { date: formatDateTimeTimestamp(last.date, timestampFormat) }),
    gt("Subject: {subject}", { subject: last.subject }),
    gt("To: {recipients}", { recipients: last.to.map(address).join(", ") }),
    "",
    last.fullText || last.text || "",
  ];
  return lines.join("\n");
}

/** Writes a reply or forward under the email, so the email and its chat stay in view. */
export function MailComposer({
  environmentId,
  detail,
  from,
  timestampFormat,
  refresh,
  task,
  close,
}: {
  environmentId: EnvironmentId;
  detail: MailThreadDetail;
  from: string;
  timestampFormat: TimestampFormat;
  refresh: () => void;
  task: ComposeTask;
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
  // The copy being edited; saving here replaces it, another client's edit makes it stale.
  const [draft, setDraft] = useState(task.draft);
  const latest = draft && detail.drafts.find((item) => item.id === draft.id);
  const stale = draft !== null && (!latest || latest.revision !== draft.revision);
  const pending = save.pending || send.pending || discard.pending;
  const last = detail.messages.at(-1);
  const replyTo = last?.outgoing
    ? last.to.map((entry) => entry.address)
    : [last?.from.address ?? detail.thread.from.address];
  const forward = task.mode === "forward";
  const subject =
    draft?.subject ??
    (forward ? forwardSubject(detail.thread.subject) : replySubject(detail.thread.subject));
  const initial = {
    to: (draft?.to ?? (forward ? [] : replyTo)).join(", "),
    cc: draft?.cc.join(", ") ?? "",
    subject,
    body: draft?.body ?? (forward ? forwardBody(detail, timestampFormat, gt) : ""),
  };
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const showSubject = forward || subject !== replySubject(detail.thread.subject);
  const failed = latest?.status === "failed" ? latest.error : null;

  const read = () => {
    const data = new FormData(form.current ?? undefined);
    const value = (name: keyof typeof initial) => String(data.get(name) ?? initial[name]);
    return { to: value("to"), cc: value("cc"), subject: value("subject"), body: value("body") };
  };
  const changed = (values: typeof initial) =>
    (Object.keys(initial) as Array<keyof typeof initial>).some(
      (key) => values[key] !== initial[key],
    );
  const persist = async (values: typeof initial) => {
    const result = await save.run({
      threadId: detail.thread.id,
      ...(draft ? { draftId: draft.id, expectedRevision: draft.revision } : {}),
      to: parseRecipients(values.to),
      cc: parseRecipients(values.cc),
      subject: values.subject,
      body: values.body,
    });
    refresh();
    if (!result) return null;
    setDraft(result.value);
    return result.value;
  };

  return (
    <form
      id={formId}
      ref={(node) => {
        form.current = node;
        node?.scrollIntoView({ block: "nearest" });
      }}
      aria-label={forward ? gt("Forward") : gt("Reply")}
      className="mt-4 overflow-hidden rounded-xl border border-border bg-background"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending || stale) return;
        const values = read();
        if (parseRecipients(values.to).length + parseRecipients(values.cc).length === 0) {
          form.current?.querySelector<HTMLInputElement>("input[name=to]")?.focus();
          return;
        }
        const saved = draft && !changed(values) ? draft : await persist(values);
        if (!saved) return;
        const result = await send.run({ draftId: saved.id, revision: saved.revision });
        refresh();
        if (result) close();
      }}
    >
      <fieldset disabled={pending} className="text-sm">
        <div className="flex items-center gap-2 border-b border-border/70 px-3">
          <label htmlFor={`${formId}-to`} className="shrink-0 text-muted-foreground">
            {gt("To")}
          </label>
          <Input
            id={`${formId}-to`}
            name="to"
            unstyled
            className="min-w-0 flex-1"
            defaultValue={initial.to}
            autoFocus={forward}
          />
          {showCc ? null : (
            <Button type="button" size="xs" variant="ghost-muted" onClick={() => setShowCc(true)}>
              {gt("Cc")}
            </Button>
          )}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Close")}
            onClick={async () => {
              const values = read();
              if (!changed(values) || stale || (await persist(values))) close();
            }}
          >
            <XIcon />
          </Button>
        </div>
        {showCc ? (
          <div className="flex items-center gap-2 border-b border-border/70 px-3">
            <label htmlFor={`${formId}-cc`} className="shrink-0 text-muted-foreground">
              {gt("Cc")}
            </label>
            <Input
              id={`${formId}-cc`}
              name="cc"
              unstyled
              className="min-w-0 flex-1"
              defaultValue={initial.cc}
            />
          </div>
        ) : null}
        {showSubject ? (
          <div className="flex items-center gap-2 border-b border-border/70 px-3">
            <label htmlFor={`${formId}-subject`} className="shrink-0 text-muted-foreground">
              {gt("Subject")}
            </label>
            <Input
              id={`${formId}-subject`}
              name="subject"
              unstyled
              className="min-w-0 flex-1"
              defaultValue={initial.subject}
            />
          </div>
        ) : null}
        <Textarea
          name="body"
          aria-label={gt("Message")}
          unstyled
          rows={8}
          defaultValue={initial.body}
          autoFocus={!forward}
          onFocus={(event) => {
            if (forward) event.currentTarget.setSelectionRange(0, 0);
          }}
        />
      </fieldset>
      {stale || failed ? (
        <p role="alert" className="px-3 pb-2 text-sm text-warning-foreground">
          {stale
            ? gt("This draft changed elsewhere. Close it to open the latest version.")
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
          disabled={pending || stale}
          onClick={async () => {
            if (await persist(read())) close();
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
            if (!draft) return close();
            const result = await discard.run({
              draftId: draft.id,
              expectedRevision: draft.revision,
            });
            refresh();
            if (result) close();
          }}
        >
          <Trash2Icon />
        </Button>
      </div>
    </form>
  );
}

export function MailThreadDrafts(props: {
  environmentId: EnvironmentId;
  drafts: MailThreadDetail["drafts"];
  onOpen: (draft: MailDraft) => void;
}) {
  const gt = useGT();
  const canSave = useAtomValue(mailEnvironment.saveDraft.permissionAtom(props.environmentId));
  return (
    <>
      {props.drafts.map((draft) => (
        <article key={draft.id} className="space-y-2 rounded-lg border border-border p-3">
          <h2 className="text-sm font-semibold">
            {draft.status === "sending"
              ? gt("Sending…")
              : draft.origin === "agent" || draft.origin === "ai"
                ? gt("Agent draft")
                : gt("Draft")}
          </h2>
          <p className="line-clamp-3 text-sm whitespace-pre-wrap wrap-anywhere">{draft.body}</p>
          {draft.error && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {draft.error}
            </p>
          )}
          {(draft.status === "draft" || draft.status === "failed") && canSave ? (
            <Button size="sm" variant="outline" onClick={() => props.onOpen(draft)}>
              {gt("Open draft")}
            </Button>
          ) : null}
        </article>
      ))}
    </>
  );
}
