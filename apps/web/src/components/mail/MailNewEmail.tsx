import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MailAccountId,
  MailDraft,
  MailDraftFile,
  MailThreadDetail,
  MailThreadRow,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { MessageSquareIcon, SendIcon, Trash2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { mailEnvironment } from "../../state/mail";
import { useMailCommand } from "../settings/MailSettings.commands";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import { Toggle } from "../ui/toggle";
import { MailChatAside } from "./MailChatPanel";
import { MailAttachButton, MailDraftFileList, useMailDraftUpload } from "./MailDraftFiles";
import { parseRecipients } from "./mailPresentation";
import { MailPage } from "./MailPage";
import { useDiscardDraft } from "./useDiscardDraft";

interface Fields {
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly body: string;
  readonly files: ReadonlyArray<MailDraftFile>;
}

const EMPTY: Fields = { to: "", cc: "", bcc: "", subject: "", body: "", files: [] };
const AUTOSAVE_MS = 1_500;

const fieldsOf = (draft: MailDraft | null): Fields =>
  draft
    ? {
        to: draft.to.join(", "),
        cc: draft.cc.join(", "),
        bcc: draft.bcc.join(", "),
        subject: draft.subject,
        body: draft.body,
        files: draft.files,
      }
    : EMPTY;

const fileKey = (files: ReadonlyArray<MailDraftFile>) => files.map((file) => file.id).join(",");
const sameFields = (a: Fields, b: Fields) =>
  a.to === b.to &&
  a.cc === b.cc &&
  a.bcc === b.bcc &&
  a.subject === b.subject &&
  a.body === b.body &&
  fileKey(a.files) === fileKey(b.files);

/**
 * A new email, written like a new chat: it becomes a draft once there is something to keep,
 * and its chat can help write it.
 */
export function MailNewEmail({
  environmentId,
  thread,
  detail,
  composeId = null,
  onCreated,
  chatOpen,
  onChatOpenChange,
}: {
  environmentId: EnvironmentId;
  /** Null until the email is first saved. */
  thread: MailThreadRow | null;
  detail: MailThreadDetail | null;
  /** Set on the New email page: the id its first save creates the email under. */
  composeId?: string | null;
  onCreated?: (draft: MailDraft) => void;
  chatOpen: boolean;
  onChatOpenChange: (open: boolean) => void;
}) {
  const gt = useGT();
  const wide = useMediaQuery("lg");
  const view = useAtomValue(mailEnvironment.view(environmentId));
  const accounts = view?.status.accounts ?? [];
  const latest = detail?.drafts.findLast((draft) => draft.status !== "sent") ?? null;
  if (thread === null && view !== null && accounts.length === 0) {
    return (
      <MailPage title={gt("New email")}>
        <p className="p-6 text-sm text-muted-foreground">
          <T>Connect an email account in Settings to send email.</T>
        </p>
      </MailPage>
    );
  }
  // The sender list and, for a saved email, its draft must be known before editing starts.
  if (view === null || (composeId === null && thread !== null && detail === null)) {
    return (
      <MailPage title={gt("New email")}>
        <p role="status" className="p-6 text-sm text-muted-foreground">
          {gt("Loading email…")}
        </p>
      </MailPage>
    );
  }
  return (
    <MailNewEmailEditor
      environmentId={environmentId}
      accounts={accounts}
      thread={thread}
      composeId={composeId}
      onCreated={onCreated}
      initialDraft={latest}
      latest={latest}
      wide={wide}
      chatOpen={chatOpen}
      onChatOpenChange={onChatOpenChange}
    />
  );
}

function MailNewEmailEditor({
  environmentId,
  accounts,
  thread,
  composeId,
  onCreated,
  initialDraft,
  latest,
  wide,
  chatOpen,
  onChatOpenChange,
}: {
  environmentId: EnvironmentId;
  accounts: ReadonlyArray<{ readonly id: MailAccountId; readonly email: string }>;
  thread: MailThreadRow | null;
  composeId: string | null;
  onCreated: ((draft: MailDraft) => void) | undefined;
  initialDraft: MailDraft | null;
  latest: MailDraft | null;
  wide: boolean;
  chatOpen: boolean;
  onChatOpenChange: (open: boolean) => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const formId = useId();
  const form = useRef<HTMLFormElement | null>(null);
  const compose = useMailCommand(
    environmentId,
    mailEnvironment.compose,
    gt("Could not save draft"),
  );
  const save = useMailCommand(environmentId, mailEnvironment.saveDraft, gt("Could not save draft"));
  const send = useMailCommand(environmentId, mailEnvironment.sendDraft, gt("Could not send email"));
  const openSession = useMailCommand(
    environmentId,
    mailEnvironment.openSession,
    gt("Could not open mail chat"),
  );
  const discardDraft = useDiscardDraft(environmentId);
  const canSend = useAtomValue(mailEnvironment.sendDraft.permissionAtom(environmentId));
  const canSave = useAtomValue(mailEnvironment.compose.permissionAtom(environmentId));

  const [accountId, setAccountId] = useState<MailAccountId | null>(
    thread?.accountId ?? accounts[0]?.id ?? null,
  );
  const [fields, setFields] = useState<Fields>(() => fieldsOf(initialDraft));
  // The last saved copy. An edit made elsewhere, such as by the chat, replaces it.
  const [draft, setDraft] = useState(initialDraft);
  const [savedFields, setSavedFields] = useState(fields);
  const [showCc, setShowCc] = useState(fields.cc.length > 0);
  const [showBcc, setShowBcc] = useState(fields.bcc.length > 0);
  const uploads = useMailDraftUpload(environmentId);
  const [saving, setSaving] = useState(false);
  const [openedChatId, setOpenedChatId] = useState<ThreadId | null>(null);
  // Set before the first await, so a second click or an edit can't slip in mid-send.
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const dirty = !sameFields(fields, savedFields);
  const hasContent = !sameFields(fields, EMPTY);
  // The chat saved a newer version: take it, unless the user has typed since.
  const newer = !saving && latest !== null && draft !== null && latest.revision > draft.revision;
  if (newer && !dirty) {
    setDraft(latest);
    setFields(fieldsOf(latest));
    setSavedFields(fieldsOf(latest));
    if (latest.cc.length > 0) setShowCc(true);
    if (latest.bcc.length > 0) setShowBcc(true);
  }
  const conflict = newer && dirty;
  const sending = latest?.status === "sending" || send.pending;
  const failed = latest?.status === "failed" ? latest.error : null;
  const pending = sending || openSession.pending || busy;
  const senderId = draft?.accountId ?? thread?.accountId ?? accountId;
  const account = accounts.find((entry) => entry.id === senderId);
  // Uploaded files belong to the account they were attached from.
  const canPickSender =
    draft === null && thread === null && !saving && fields.files.length === 0 && !uploads.uploading;

  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // Queued saves run after earlier ones finish, so they read the newest saved copy here.
  const saved = useRef(draft);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Queued saves must see a draft taken from the chat.
  useEffect(() => {
    saved.current = draft;
  }, [draft]);
  const persistNow = async (values: Fields, base: MailDraft | null) => {
    if (base !== null && sameFields(values, fieldsOf(base))) return base;
    const input = {
      to: parseRecipients(values.to),
      cc: parseRecipients(values.cc),
      bcc: parseRecipients(values.bcc),
      fileIds: values.files.map((file) => file.id),
      subject: values.subject,
      body: values.body,
    };
    const result =
      base === null
        ? accountId === null
          ? null
          : await compose.run({ ...(composeId ? { id: composeId } : {}), accountId, ...input })
        : await save.run({
            threadId: base.threadId,
            draftId: base.id,
            expectedRevision: base.revision,
            ...input,
          });
    if (!result) return null;
    saved.current = result.value;
    setDraft(result.value);
    setSavedFields(values);
    if (base === null) onCreated?.(result.value);
    return result.value;
  };
  const claim = () => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  };
  const release = () => {
    busyRef.current = false;
    setBusy(false);
  };
  /** One save at a time, in order, so a pause-save and Send never race. */
  const persist = (values: Fields, base?: MailDraft) => {
    const next = queue.current.then(() => {
      setSaving(true);
      return persistNow(values, base ?? saved.current).finally(() => setSaving(false));
    });
    queue.current = next.catch(() => null);
    return next;
  };

  const finished = useRef(false);
  // Nothing typed yet is not worth a draft; clearing a saved one still saves.
  const autosave = useEffectEvent(() => {
    if (finished.current || busyRef.current || !dirty || conflict || !canSave) return;
    if (hasContent || saved.current !== null) void persist(fields);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Saves the draft after a pause in typing.
  useEffect(() => {
    if (saving || sameFields(fields, savedFields)) return;
    const timer = setTimeout(autosave, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [fields, savedFields, saving]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps unsaved text when the editor unmounts.
  useEffect(() => () => autosave(), []);

  const set = (key: Exclude<keyof Fields, "files">) => (value: string) =>
    setFields({ ...fields, [key]: value });
  const attach = (picked: ReadonlyArray<File>) => {
    if (senderId === null) return;
    void uploads.upload(senderId, picked, fields.files, (file) =>
      setFields((current) => ({ ...current, files: [...current.files, file] })),
    );
  };
  const chatThreadId = thread?.chatThreadId ?? openedChatId;
  const showChat = chatOpen && chatThreadId !== null;
  const setChatOpen = async (open: boolean) => {
    if (!open) return onChatOpenChange(false);
    // The chat reads the saved draft, so it starts from what is on screen.
    const current = draft !== null && !dirty ? draft : await persist(fields);
    if (!current) return;
    if (chatThreadId !== null && composeId === null) return onChatOpenChange(true);
    const result = await openSession.run({ threadId: current.threadId });
    if (!result) return;
    if (composeId !== null) {
      finished.current = true;
      void navigate({
        to: "/mail/$mailThreadId",
        params: { mailThreadId: current.threadId },
        search: { chat: true },
        replace: true,
      });
      return;
    }
    setOpenedChatId(result.value.threadId);
    onChatOpenChange(true);
  };

  const field = (key: "to" | "cc" | "bcc" | "subject", label: string, autoFocus = false) => (
    <div className="flex min-h-10 items-center gap-2 border-b border-border/70 px-4">
      <label htmlFor={`${formId}-${key}`} className="w-16 shrink-0 text-muted-foreground">
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
        {...(key === "subject" ? {} : { autoComplete: "email" })}
      />
      {key === "to" && !showCc ? (
        <Button type="button" size="xs" variant="ghost-muted" onClick={() => setShowCc(true)}>
          {gt("Cc")}
        </Button>
      ) : null}
      {key === "to" && uploads.capabilities?.bcc && !showBcc ? (
        <Button type="button" size="xs" variant="ghost-muted" onClick={() => setShowBcc(true)}>
          {gt("Bcc")}
        </Button>
      ) : null}
    </div>
  );

  return (
    <MailPage
      title={gt("New email")}
      toolbar={
        <Toggle
          variant="ghost"
          size="sm"
          pressed={showChat}
          disabled={!canSave || pending}
          onPressedChange={(open) => void setChatOpen(open)}
        >
          <MessageSquareIcon />
          <T>Chat</T>
        </Toggle>
      }
      scroll={false}
    >
      <div className="relative flex h-full min-h-0 gap-3 px-3 pb-3">
        <section
          aria-label={gt("New email")}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card"
        >
          <form
            id={formId}
            ref={form}
            aria-label={gt("New email")}
            className="flex min-h-0 flex-1 flex-col text-sm"
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending || conflict || uploads.uploading) return;
              if ([fields.to, fields.cc, fields.bcc].flatMap(parseRecipients).length === 0) {
                form.current?.querySelector<HTMLInputElement>("input[name=to]")?.focus();
                return;
              }
              if (!claim()) return;
              const ready = await persist(fields);
              if (!ready) return release();
              finished.current = true;
              const result = await send.run({ draftId: ready.id, revision: ready.revision });
              if (!result) {
                finished.current = false;
                return release();
              }
              if (composeId !== null) {
                void navigate({
                  to: "/mail/$mailThreadId",
                  params: { mailThreadId: ready.threadId },
                  replace: true,
                });
              }
            }}
          >
            <fieldset disabled={pending || !canSave} className="flex min-h-0 flex-1 flex-col">
              {accounts.length > 1 ? (
                <div className="flex min-h-10 items-center gap-2 border-b border-border/70 px-4">
                  <span className="w-16 shrink-0 text-muted-foreground">
                    <T>From</T>
                  </span>
                  {canPickSender ? (
                    <Select
                      value={accountId}
                      onValueChange={(value) => {
                        if (value) setAccountId(value);
                      }}
                    >
                      <SelectTrigger size="xs" variant="ghost" aria-label={gt("From")}>
                        {account?.email}
                      </SelectTrigger>
                      <SelectPopup>
                        {accounts.map((entry) => (
                          <SelectItem key={entry.id} value={entry.id}>
                            {entry.email}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  ) : (
                    <span className="min-w-0 truncate">{account?.email}</span>
                  )}
                </div>
              ) : null}
              {field("to", gt("To"), fields.to.length === 0)}
              {showCc ? field("cc", gt("Cc")) : null}
              {showBcc ? field("bcc", gt("Bcc")) : null}
              {field("subject", gt("Subject"))}
              {/* Fills the page like a letter, which the shared textarea's capped height can't. */}
              <textarea
                name="body"
                aria-label={gt("Message")}
                className="min-h-40 flex-1 resize-none bg-transparent px-4 py-3 outline-none wrap-anywhere"
                value={fields.body}
                onChange={(event) => set("body")(event.currentTarget.value)}
                autoFocus={fields.to.length > 0}
              />
              <MailDraftFileList
                className="px-4 pb-3"
                files={fields.files}
                disabled={pending}
                onRemove={(id) =>
                  setFields({ ...fields, files: fields.files.filter((file) => file.id !== id) })
                }
              />
            </fieldset>
            {conflict || failed || uploads.error ? (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 border-t border-border/70 px-4 py-2 text-warning-foreground"
              >
                <span className="min-w-0 flex-1">
                  {conflict ? gt("The draft changed in chat.") : (failed ?? uploads.error)}
                </span>
                {conflict && latest ? (
                  <>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        saved.current = latest;
                        setDraft(latest);
                        setFields(fieldsOf(latest));
                        setSavedFields(fieldsOf(latest));
                      }}
                    >
                      {gt("Use new version")}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        saved.current = latest;
                        setDraft(latest);
                        void persist(fields, latest);
                      }}
                    >
                      {gt("Keep mine")}
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
            <div className="flex items-center gap-3 border-t border-border/70 px-4 py-3">
              {canSend ? (
                <Button type="submit" size="sm" disabled={pending || conflict || uploads.uploading}>
                  <SendIcon />
                  {sending ? gt("Sending…") : gt("Send")}
                </Button>
              ) : null}
              {canSave && uploads.capabilities?.draftAttachments ? (
                <MailAttachButton
                  disabled={pending || uploads.uploading || senderId === null}
                  onPick={attach}
                />
              ) : null}
              <span role="status" className="min-w-0 truncate text-xs text-muted-foreground">
                {uploads.uploading
                  ? gt("Attaching…")
                  : saving
                    ? gt("Saving…")
                    : draft !== null && !dirty
                      ? gt("Draft saved")
                      : null}
              </span>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost-muted"
                className="ml-auto"
                aria-label={gt("Discard draft")}
                disabled={pending}
                onClick={async () => {
                  if (!claim()) return;
                  finished.current = true;
                  // A save still on its way would otherwise recreate what is discarded here.
                  await queue.current;
                  const current = saved.current;
                  if (current !== null && !(await discardDraft(current))) {
                    finished.current = false;
                    return release();
                  }
                  void navigate({ to: "/mail" });
                }}
              >
                <Trash2Icon />
              </Button>
            </div>
          </form>
        </section>
        {showChat ? (
          <MailChatAside
            environmentId={environmentId}
            chatThreadId={chatThreadId}
            wide={wide}
            onClose={() => onChatOpenChange(false)}
          />
        ) : null}
      </div>
    </MailPage>
  );
}
