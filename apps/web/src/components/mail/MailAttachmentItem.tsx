import {
  type EnvironmentId,
  type MailAttachment,
  type MailAttachmentInput,
} from "@t3tools/contracts";
import { filePreviewKind, hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import { useGT } from "gt-react";
import { DownloadIcon, PaperclipIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { formatBytes } from "../../lib/formatBytes";
import { fetchMailAttachment, isMailAttachmentError } from "../../state/mailAttachment";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

const AttachmentFilePreview = lazy(() =>
  import("../files/AttachmentFilePreview").then((module) => ({
    default: module.AttachmentFilePreview,
  })),
);

export function MailAttachmentItem({
  environmentId,
  input,
  file,
}: {
  environmentId: EnvironmentId;
  input: MailAttachmentInput;
  file: MailAttachment;
}) {
  const gt = useGT();
  const name = file.filename || file.contentType;
  const kind = filePreviewKind({ name, mimeType: file.contentType });
  const mediaType = file.contentType.startsWith(kind + "/")
    ? file.contentType
    : hostPreviewMimeTypeFromExtension(name.slice(name.lastIndexOf(".")));
  // Mail can come from anyone. Only open passive viewers for sender-supplied files.
  const isMedia = ["image", "audio", "video"].includes(kind) && mediaType !== "image/svg+xml";
  const canPreview = isMedia || ["pdf", "text", "docx", "xlsx", "pptx"].includes(kind);
  const [open, setOpen] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel the file transfer when its message leaves the reader.
  useEffect(() => () => request.current?.abort(), []);

  function close() {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setOpen(false);
    setBlob(null);
    setError("");
  }

  async function load(preview: boolean) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setOpen(preview);
    try {
      const bytes = await fetchMailAttachment(environmentId, input, controller.signal);
      if (controller.signal.aborted) return;
      // A filename can select the PDF viewer even when the sender supplied a different MIME type.
      const previewType = kind === "pdf" ? "application/pdf" : isMedia ? mediaType : null;
      const type = (preview && previewType) || "application/octet-stream";
      const content = new Blob([new Uint8Array(bytes)], { type });
      if (preview) {
        setBlob(content);
      } else {
        const url = URL.createObjectURL(content);
        // Desktop and WebKit can start saving after the click handler returns.
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.click();
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          isMailAttachmentError(cause) ? cause.message : gt("Could not download {name}", { name }),
        );
      }
    }
    if (!controller.signal.aborted) {
      request.current = null;
      setBusy(false);
    }
  }

  const download = gt("Download {label}", { label: name });
  const loading = (
    <p role="status" className="m-auto p-4 text-sm text-muted-foreground">
      {gt("Loading…")}
    </p>
  );
  return (
    <li className="min-w-0 max-w-full">
      <div className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 px-1">
        <Button
          variant="ghost-muted"
          size="xs"
          className="min-w-0"
          disabled={busy}
          aria-label={canPreview ? gt("Preview {name}", { name }) : download}
          onClick={() => void load(canPreview)}
        >
          <PaperclipIcon aria-hidden />
          <span className="truncate">{name}</span>
          <span className="shrink-0 text-muted-foreground">{formatBytes(file.size)}</span>
          {canPreview ? null : <DownloadIcon aria-hidden />}
        </Button>
        {canPreview && (
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label={download}
            title={download}
            disabled={busy}
            onClick={() => void load(false)}
          >
            <DownloadIcon />
          </Button>
        )}
      </div>
      {busy && !open && (
        <span role="status" className="ml-2 text-muted-foreground">
          {gt("Downloading…")}
        </span>
      )}
      {!open && error && (
        <p role="alert" className="mt-1 text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        {open && (
          <DialogPopup className="h-[75dvh] max-w-4xl overflow-hidden" showCloseButton={!blob}>
            <DialogTitle className="sr-only">{name}</DialogTitle>
            {blob ? (
              <Suspense fallback={loading}>
                <AttachmentFilePreview
                  name={name}
                  mimeType={file.contentType}
                  sizeBytes={blob.size}
                  file={blob}
                  onClose={close}
                />
              </Suspense>
            ) : error ? (
              <div className="m-auto p-4 text-center">
                <p role="alert" className="mb-2 text-sm">
                  {error}
                </p>
                <Button size="sm" variant="outline" onClick={() => void load(true)}>
                  {gt("Retry")}
                </Button>
              </div>
            ) : (
              loading
            )}
          </DialogPopup>
        )}
      </Dialog>
    </li>
  );
}
