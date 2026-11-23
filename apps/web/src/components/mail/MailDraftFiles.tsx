import {
  MAIL_OUTGOING_FILE_BYTES,
  type EnvironmentId,
  type MailAccountId,
  type MailDraftFile,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { PaperclipIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useMailStatus } from "../../state/mail";
import { formatBytes } from "../../lib/formatBytes";
import { isMailAttachmentError, uploadMailDraftFile } from "../../state/mailAttachment";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/**
 * Uploads picked files for a draft. Each finished upload is handed to `onAdded`; the draft
 * holds it once saved, so an upload alone attaches nothing.
 */
export function useMailDraftUpload(environmentId: EnvironmentId) {
  const gt = useGT();
  const capabilities = useMailStatus(environmentId)?.capabilities;
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancels uploads when the editor closes.
  useEffect(() => () => request.current?.abort(), []);

  const upload = async (
    accountId: MailAccountId,
    picked: ReadonlyArray<File>,
    attached: ReadonlyArray<MailDraftFile>,
    onAdded: (file: MailDraftFile) => void,
  ) => {
    if (request.current) return;
    setError("");
    const total = [...attached, ...picked].reduce((sum, file) => sum + file.size, 0);
    if (total > MAIL_OUTGOING_FILE_BYTES) {
      setError(
        gt("Attachments can total at most {size}.", {
          size: formatBytes(MAIL_OUTGOING_FILE_BYTES),
        }),
      );
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setUploading(true);
    for (const file of picked) {
      try {
        const content = new Uint8Array(await file.arrayBuffer());
        if (controller.signal.aborted) break;
        const stored = await uploadMailDraftFile(
          environmentId,
          { accountId, filename: file.name, ...(file.type ? { contentType: file.type } : {}) },
          content,
          controller.signal,
        );
        if (controller.signal.aborted) break;
        onAdded(stored);
      } catch (cause) {
        if (controller.signal.aborted) break;
        setError(
          isMailAttachmentError(cause)
            ? cause.message
            : gt("Could not attach {name}.", { name: file.name }),
        );
      }
    }
    request.current = null;
    if (!controller.signal.aborted) setUploading(false);
  };

  return { capabilities, uploading, error, upload };
}

export function MailAttachButton({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (files: ReadonlyArray<File>) => void;
}) {
  const gt = useGT();
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (files.length > 0) onPick(files);
        }}
      />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost-muted"
        aria-label={gt("Attach files")}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <PaperclipIcon />
      </Button>
    </>
  );
}

export function MailDraftFileList({
  files,
  disabled,
  onRemove,
  className,
}: {
  files: ReadonlyArray<MailDraftFile>;
  disabled: boolean;
  onRemove: (id: string) => void;
  className?: string;
}) {
  const gt = useGT();
  if (files.length === 0) return null;
  return (
    <ul aria-label={gt("Attachments")} className={cn("flex flex-wrap gap-1.5", className)}>
      {files.map((file) => (
        <li
          key={file.id}
          className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-1.5 text-xs"
        >
          <PaperclipIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{file.filename}</span>
          <span className="shrink-0 text-muted-foreground">{formatBytes(file.size)}</span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Remove {name}", { name: file.filename })}
            disabled={disabled}
            onClick={() => onRemove(file.id)}
          >
            <XIcon />
          </Button>
        </li>
      ))}
    </ul>
  );
}
