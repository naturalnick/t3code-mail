import type { MailDraft } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { SquarePenIcon } from "lucide-react";

import { cn } from "../../lib/utils";

/** A saved draft in the conversation, under the message it answers; opening it resumes editing. */
export function MailDraftRow({
  draft,
  disabled,
  onOpen,
}: {
  draft: MailDraft;
  disabled: boolean;
  onOpen: () => void;
}) {
  const gt = useGT();
  const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
  const label =
    draft.status === "sending"
      ? gt("Sending…")
      : draft.status === "failed"
        ? gt("Not sent")
        : draft.mode === "forward"
          ? draft.origin === "user"
            ? gt("Forward draft")
            : gt("Agent forward draft")
          : draft.origin === "user"
            ? gt("Reply draft")
            : gt("Agent reply draft");
  const body = draft.body.replace(/\s+/g, " ").trim();
  return (
    <div className="my-2">
      <button
        type="button"
        disabled={disabled || draft.status === "sending"}
        onClick={onOpen}
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-sm hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent",
          draft.status === "failed" ? "border-destructive/50" : "border-warning/50",
        )}
      >
        <SquarePenIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
        <span className="shrink-0 font-medium text-warning-foreground">{label}</span>
        {recipients.length > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {gt("to {recipients}", { recipients: recipients.join(", ") })}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{body}</span>
      </button>
      {draft.error ? (
        <p role="alert" className="mt-1 px-1 text-xs text-destructive-foreground">
          {draft.error}
        </p>
      ) : null}
    </div>
  );
}
