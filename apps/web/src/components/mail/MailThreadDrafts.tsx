import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MailDraft, MailThreadDetail } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useId, useState } from "react";

import { mailEnvironment } from "../../state/mail";
import { useMailCommand } from "../settings/MailSettings.commands";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { parseRecipients, replySubject } from "./mailPresentation";

type DraftTask =
  | { kind: "edit"; draft: MailDraft | null }
  | { kind: "send" | "discard"; draft: MailDraft };

interface DraftProps {
  environmentId: EnvironmentId;
  detail: MailThreadDetail;
  from: string;
  refreshing: boolean;
  refresh: () => void;
}

function DraftDialog({
  environmentId,
  detail,
  from,
  refreshing,
  refresh,
  task,
  close,
}: DraftProps & { task: DraftTask; close: () => void }) {
  const gt = useGT();
  const formId = useId();
  const save = useMailCommand(environmentId, mailEnvironment.saveDraft, gt("Could not save draft"));
  const send = useMailCommand(environmentId, mailEnvironment.sendDraft, gt("Could not send reply"));
  const discard = useMailCommand(
    environmentId,
    mailEnvironment.discardDraft,
    gt("Could not discard draft"),
  );
  // Keep the reviewed copy until this dialog closes, even when another client publishes an edit.
  const draft = task.draft;
  const latest = draft && detail.drafts.find((item) => item.id === draft.id);
  const stale =
    draft !== null &&
    (!latest ||
      latest.revision !== draft.revision ||
      latest.status !== draft.status ||
      latest.updatedAt !== draft.updatedAt);
  const command = task.kind === "edit" ? save : task.kind === "send" ? send : discard;
  const noRecipients = task.kind === "send" && task.draft.to.length + task.draft.cc.length === 0;
  const disabled = command.disabled || stale || refreshing || noRecipients;
  const last = detail.messages.at(-1);
  const replyTo = last?.outgoing
    ? last.to.map((entry) => entry.address)
    : [last?.from.address ?? detail.thread.from.address];
  const failed = draft?.status === "failed" ? draft.error : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.pending) close();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {task.kind === "send"
              ? gt("Review reply")
              : task.kind === "discard"
                ? gt("Discard draft?")
                : draft
                  ? gt("Edit draft")
                  : gt("Draft reply")}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {stale && (
            <p role="alert" className="mb-3 text-sm text-warning-foreground">
              {gt("This draft changed elsewhere. Close this window to review the latest version.")}
            </p>
          )}
          {failed && (
            <p role="alert" className="mb-3 text-sm text-destructive-foreground">
              {failed}
            </p>
          )}
          {task.kind === "edit" ? (
            <form
              id={formId}
              onSubmit={async (event) => {
                event.preventDefault();
                if (disabled) return;
                const data = new FormData(event.currentTarget);
                const value = (name: string) => String(data.get(name) ?? "");
                const result = await save.run({
                  threadId: detail.thread.id,
                  ...(draft ? { draftId: draft.id, expectedRevision: draft.revision } : {}),
                  to: parseRecipients(value("to")),
                  cc: parseRecipients(value("cc")),
                  subject: value("subject"),
                  body: value("body"),
                });
                refresh();
                if (result) close();
              }}
            >
              <fieldset disabled={command.pending} className="grid gap-3 text-sm">
                <label className="grid gap-1">
                  {gt("To")}
                  <Input name="to" defaultValue={(draft?.to ?? replyTo).join(", ")} />
                </label>
                <label className="grid gap-1">
                  {gt("Cc")}
                  <Input name="cc" defaultValue={draft?.cc.join(", ") ?? ""} />
                </label>
                <label className="grid gap-1">
                  {gt("Subject")}
                  <Input
                    name="subject"
                    defaultValue={draft?.subject ?? replySubject(detail.thread.subject)}
                  />
                </label>
                <label className="grid gap-1">
                  {gt("Reply")}
                  <Textarea name="body" rows={7} defaultValue={draft?.body ?? ""} />
                </label>
              </fieldset>
            </form>
          ) : (
            <div className="space-y-2 text-sm wrap-anywhere">
              {from && <p>{gt("From: {sender}", { sender: from })}</p>}
              {task.draft.to.length > 0 && (
                <p>{gt("To: {recipients}", { recipients: task.draft.to.join(", ") })}</p>
              )}
              {noRecipients && <p>{gt("Edit the draft to add a recipient.")}</p>}
              {task.draft.cc.length > 0 && (
                <p>{gt("Cc: {recipients}", { recipients: task.draft.cc.join(", ") })}</p>
              )}
              <p className="font-medium">{task.draft.subject || gt("(No subject)")}</p>
              <p className="whitespace-pre-wrap">{task.draft.body}</p>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={command.pending} onClick={close}>
            {gt("Cancel")}
          </Button>
          {task.kind === "edit" ? (
            <Button type="submit" form={formId} disabled={disabled}>
              {gt("Save draft")}
            </Button>
          ) : (
            <Button
              variant={task.kind === "discard" ? "destructive" : "default"}
              disabled={disabled}
              onClick={async () => {
                if (disabled) return;
                const result =
                  task.kind === "send"
                    ? await send.run({ draftId: task.draft.id, revision: task.draft.revision })
                    : await discard.run({
                        draftId: task.draft.id,
                        expectedRevision: task.draft.revision,
                      });
                refresh();
                if (result) close();
              }}
            >
              {task.kind === "send" ? gt("Approve and send") : gt("Discard draft")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function MailThreadDrafts(props: DraftProps) {
  const gt = useGT();
  const [task, setTask] = useState<DraftTask | null>(null);
  const canSave = useAtomValue(mailEnvironment.saveDraft.permissionAtom(props.environmentId));
  const canSend = useAtomValue(mailEnvironment.sendDraft.permissionAtom(props.environmentId));
  const canDiscard = useAtomValue(mailEnvironment.discardDraft.permissionAtom(props.environmentId));
  return (
    <section className="space-y-3">
      {props.detail.drafts.map((draft) => (
        <article key={draft.id} className="space-y-2 rounded-lg border border-border p-3">
          <h2 className="text-sm font-semibold">
            {draft.status === "sending"
              ? gt("Sending reply…")
              : draft.origin === "agent" || draft.origin === "ai"
                ? gt("Agent draft")
                : gt("Draft reply")}
          </h2>
          <p className="line-clamp-3 text-sm whitespace-pre-wrap wrap-anywhere">{draft.body}</p>
          {draft.error && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {draft.error}
            </p>
          )}
          {(draft.status === "draft" || draft.status === "failed") && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setTask({ kind: "send", draft })}>
                {canSend ? gt("Review and send") : gt("View draft")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!canSave}
                onClick={() => setTask({ kind: "edit", draft })}
              >
                {gt("Edit")}
              </Button>
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={!canDiscard}
                onClick={() => setTask({ kind: "discard", draft })}
              >
                {gt("Discard")}
              </Button>
            </div>
          )}
        </article>
      ))}
      <Button
        size="sm"
        variant="outline"
        disabled={!canSave}
        onClick={() => setTask({ kind: "edit", draft: null })}
      >
        {gt("Draft reply")}
      </Button>
      {task && <DraftDialog {...props} task={task} close={() => setTask(null)} />}
    </section>
  );
}
