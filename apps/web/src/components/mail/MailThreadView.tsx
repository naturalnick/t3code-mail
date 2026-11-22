import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MailAddress,
  MailMessage,
  MailThreadDetail,
  MailThreadId,
  MailThreadRow,
  ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Link } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { BotIcon, PaperclipIcon, TriangleAlertIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useState, type ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useClientSettings } from "../../hooks/useSettings";
import { formatBytes } from "../../lib/formatBytes";
import { observeIntersection } from "../../lib/observeIntersection";
import { cn } from "../../lib/utils";
import { mailEnvironment } from "../../state/mail";
import { useEnvironmentQuery } from "../../state/query";
import { formatDateTimeTimestamp } from "../../timestampFormat";
import { useMailCommand } from "../settings/MailSettings.commands";
import { Button, InlineButton } from "../ui/button";
import { MailChatPanel } from "./MailChatPanel";
import { MailFormattedMessage, rememberedMessageHeight } from "./MailFormattedMessage";
import {
  actionLabel,
  actorLabel,
  guardrailLabel,
  nudgeLabel,
  senderName,
  settleReasonLabel,
} from "./mailPresentation";
import { MailPage } from "./MailPage";
import { MailThreadToolbar } from "./MailThreadControls";
import { MailDraftDialog, MailThreadDrafts, type DraftTask } from "./MailThreadDrafts";
import { useMailActions } from "./useMailActions";

const DETAILS_PANEL_KEY = "t3code:mail-details-panel";

function address(entry: MailAddress) {
  return entry.name && entry.name !== entry.address
    ? `${entry.name} <${entry.address}>`
    : entry.address;
}

function ThreadMessage({
  message,
  threadId,
  environmentId,
  timestampFormat,
  eager,
}: {
  message: MailMessage;
  threadId: MailThreadId;
  environmentId: EnvironmentId;
  timestampFormat: TimestampFormat;
  eager: boolean;
}) {
  const gt = useGT();
  const [showCleaned, setShowCleaned] = useState(false);
  const [visible, setVisible] = useState(eager);
  const observe = (node: HTMLElement | null) => {
    if (node === null || visible) return;
    return observeIntersection(
      node,
      (entry) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { rootMargin: "600px" },
    );
  };
  const display = useEnvironmentQuery(
    visible
      ? mailEnvironment.messageBody({
          environmentId,
          input: { threadId, messageId: Number(message.id) },
        })
      : null,
  );
  const formatted = display.data;
  // Plain text shows only once the formatted body is known to be missing, never as a placeholder.
  const settled = display.isSuccess || display.error !== null;
  const body = showCleaned ? message.text : message.fullText || message.text;
  const hasAlternate =
    message.text !== null &&
    (formatted !== null || (message.fullText !== null && message.fullText !== message.text));
  return (
    <article ref={observe} className="min-w-0 py-5 first:pt-0 [content-visibility:auto]">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="min-w-0 text-sm font-semibold wrap-anywhere">{address(message.from)}</span>
        <span className="flex items-baseline gap-3 text-xs">
          {hasAlternate && settled ? (
            <InlineButton
              tone="muted"
              aria-pressed={showCleaned}
              onClick={() => setShowCleaned(!showCleaned)}
            >
              {showCleaned ? gt("Show original") : gt("Show cleaned")}
            </InlineButton>
          ) : null}
          <time dateTime={message.date} className="text-xs text-muted-foreground">
            {formatDateTimeTimestamp(message.date, timestampFormat)}
          </time>
        </span>
      </header>
      <div className="mb-3 text-xs wrap-anywhere text-muted-foreground">
        {message.to.length > 0 && (
          <p>{gt("To: {recipients}", { recipients: message.to.map(address).join(", ") })}</p>
        )}
        {message.cc.length > 0 && (
          <p>{gt("Cc: {recipients}", { recipients: message.cc.map(address).join(", ") })}</p>
        )}
      </div>
      {!settled ? (
        <div aria-hidden style={{ height: rememberedMessageHeight(message.id) ?? 0 }} />
      ) : formatted && !showCleaned ? (
        <MailFormattedMessage
          id={message.id}
          body={formatted}
          title={message.subject || gt("(No subject)")}
        />
      ) : (
        <p className="text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
          {body ?? gt("Message body unavailable.")}
        </p>
      )}
      {message.attachments.length > 0 && (
        <ul aria-label={gt("Attachments")} className="mt-3 space-y-1 text-xs text-muted-foreground">
          {message.attachments.map((file, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- MIME parts have fixed order and can share identical metadata.
            <li key={index} className="flex items-center gap-1.5">
              <PaperclipIcon aria-hidden className="size-3 shrink-0" />
              <span className="wrap-anywhere">
                {file.filename || file.contentType} · {formatBytes(file.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function DetailsSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5 border-t border-border/60 px-3 py-3 first:border-t-0">
      {title ? <h2 className="text-xs font-medium text-muted-foreground">{title}</h2> : null}
      {children}
    </section>
  );
}

function ActionLog({
  environmentId,
  actions,
  timestampFormat,
  refresh,
}: {
  environmentId: EnvironmentId;
  actions: MailThreadDetail["actions"];
  timestampFormat: TimestampFormat;
  refresh: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const undo = useMailCommand(
    environmentId,
    mailEnvironment.undo,
    gt("Could not undo mail action"),
  );
  return (
    <ol className="divide-y divide-border/60">
      {actions.map((entry) => (
        <li key={entry.id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
          <div className="min-w-0">
            <p>
              {actionLabel(entry, resolve)} · {actorLabel(entry, resolve)}
            </p>
            <time dateTime={entry.at} className="text-muted-foreground">
              {formatDateTimeTimestamp(entry.at, timestampFormat)}
            </time>
          </div>
          {entry.undoneAt ? (
            <span className="text-muted-foreground">{gt("Undone")}</span>
          ) : entry.undoable ? (
            <Button
              size="compact"
              variant="outline"
              disabled={undo.disabled}
              onClick={async () => {
                await undo.run({ actionId: entry.id });
                refresh();
              }}
            >
              {gt("Undo")}
            </Button>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Thread state the reader may need; the email itself stays in its own panel. */
function MailThreadDetails({
  environmentId,
  thread,
  detail,
  account,
  timestampFormat,
  refresh,
  onDraftTask,
}: {
  environmentId: EnvironmentId;
  thread: MailThreadRow;
  detail: MailThreadDetail | null;
  account: string | null;
  timestampFormat: TimestampFormat;
  refresh: () => void;
  onDraftTask: (task: DraftTask) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const { act, disabled } = useMailActions(environmentId);
  const nudge = nudgeLabel(thread.nudge, resolve);
  const status =
    thread.state === "settled" && thread.settledReason
      ? gt("Settled as {reason}", { reason: settleReasonLabel(thread.settledReason, resolve) })
      : thread.state === "snoozed"
        ? thread.snoozedUntil
          ? gt("Snoozed until {time}", {
              time: formatDateTimeTimestamp(thread.snoozedUntil, timestampFormat),
            })
          : gt("Snoozed until reply")
        : thread.state === "working"
          ? thread.workingReason === "waiting"
            ? gt("Waiting for reply")
            : gt("Agent is drafting")
          : null;
  const hasStatus =
    status !== null ||
    nudge !== null ||
    thread.injectionWarning ||
    thread.suggestion !== null ||
    thread.suggestedAction !== null ||
    thread.guardrail !== null ||
    account !== null;
  return (
    <>
      {hasStatus ? (
        <DetailsSection>
          <div className="space-y-2 text-sm wrap-anywhere">
            {status ? (
              <p className="flex items-center gap-1.5">
                {thread.state === "settled" && thread.settledBy === "ai" ? (
                  <BotIcon aria-label={gt("Settled by AI")} className="size-3.5 shrink-0" />
                ) : null}
                {status}
              </p>
            ) : null}
            {nudge ? <p className="text-warning-foreground">{nudge}</p> : null}
            {thread.injectionWarning ? (
              <p className="flex items-center gap-1.5 text-warning-foreground">
                <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                {gt("This email reads like instructions to an AI.")}
              </p>
            ) : null}
            {thread.suggestion ? (
              <div className="flex items-center justify-between gap-2">
                <p className="flex min-w-0 items-center gap-1.5">
                  <BotIcon aria-hidden className="size-3.5 shrink-0" />
                  {gt("Suggests settling as {reason}", {
                    reason: settleReasonLabel(thread.suggestion.reason, resolve),
                  })}
                </p>
                <Button
                  size="compact"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void act([thread.id], { type: "keep" }, gt("Kept in Active"))}
                >
                  {gt("Keep in Active")}
                </Button>
              </div>
            ) : null}
            {thread.suggestedAction ? (
              <dl>
                <dt className="text-xs text-muted-foreground">{gt("Suggested next step")}</dt>
                <dd>{thread.suggestedAction}</dd>
              </dl>
            ) : null}
            {thread.guardrail ? (
              <p className="text-xs text-muted-foreground">
                {gt("Mail normally asks for review before settling messages marked “{reason}”.", {
                  reason: guardrailLabel(thread.guardrail, resolve),
                })}
              </p>
            ) : null}
            {account ? (
              <dl>
                <dt className="text-xs text-muted-foreground">{gt("Account")}</dt>
                <dd>{account}</dd>
              </dl>
            ) : null}
          </div>
        </DetailsSection>
      ) : null}
      {detail && detail.drafts.length > 0 ? (
        <DetailsSection title={gt("Drafts")}>
          <MailThreadDrafts
            environmentId={environmentId}
            drafts={detail.drafts}
            onTask={onDraftTask}
          />
        </DetailsSection>
      ) : null}
      {detail && detail.related.length > 0 ? (
        <DetailsSection title={gt("Related mail")}>
          <ul>
            {detail.related.map((item) => (
              <li key={item.id}>
                <Link
                  to="/mail/$mailThreadId"
                  params={{ mailThreadId: item.id }}
                  className="block rounded-sm py-1 text-sm hover:underline"
                >
                  <span className="block truncate">{item.subject || gt("(No subject)")}</span>
                  <time dateTime={item.lastMessageAt} className="text-xs text-muted-foreground">
                    {formatDateTimeTimestamp(item.lastMessageAt, timestampFormat)}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        </DetailsSection>
      ) : null}
      {detail && detail.actions.length > 0 ? (
        <DetailsSection title={gt("Recent actions")}>
          <ActionLog
            environmentId={environmentId}
            actions={detail.actions}
            timestampFormat={timestampFormat}
            refresh={refresh}
          />
        </DetailsSection>
      ) : null}
    </>
  );
}

function hasDetails(
  thread: MailThreadRow,
  detail: MailThreadDetail | null,
  account: string | null,
) {
  return (
    thread.state !== "active" ||
    thread.nudge !== null ||
    thread.injectionWarning ||
    thread.suggestion !== null ||
    thread.suggestedAction !== null ||
    thread.guardrail !== null ||
    account !== null ||
    (detail !== null &&
      (detail.drafts.length > 0 || detail.related.length > 0 || detail.actions.length > 0))
  );
}

export function MailThreadView({
  environmentId,
  threadId,
  chatOpen,
  onChatOpenChange,
}: {
  environmentId: EnvironmentId;
  threadId: MailThreadId;
  chatOpen: boolean;
  onChatOpenChange: (open: boolean) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const query = useEnvironmentQuery(
    mailEnvironment.thread({ environmentId, input: { threadId } }),
    resolve,
  );
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const view = useAtomValue(mailEnvironment.view(environmentId));
  const wide = useMediaQuery("lg");
  const [widePanel, setWidePanel] = useLocalStorage(DETAILS_PANEL_KEY, true, Schema.Boolean);
  const [narrowPanel, setNarrowPanel] = useState(false);
  const [draftTask, setDraftTask] = useState<DraftTask | null>(null);
  // The row learns its chat id on the next snapshot; the reply to opening one knows it now.
  const [openedChatId, setOpenedChatId] = useState<ThreadId | null>(null);
  const openSession = useMailCommand(
    environmentId,
    mailEnvironment.openSession,
    gt("Could not open mail chat"),
  );
  const canSaveDraft = useAtomValue(mailEnvironment.saveDraft.permissionAtom(environmentId));
  const detail = query.data;
  // The sidebar row is already in memory, so the header paints before the thread arrives.
  const thread = detail?.thread ?? view?.threads.get(threadId) ?? null;
  const accounts = view?.status.accounts;
  if (thread === null) {
    return (
      <MailPage>
        <div className="space-y-3 p-6 text-sm text-muted-foreground">
          <p role="status">{query.error ?? gt("Loading email…")}</p>
          {query.error && (
            <Button size="sm" variant="outline" onClick={query.refresh}>
              {gt("Retry")}
            </Button>
          )}
        </div>
      </MailPage>
    );
  }
  const from = accounts?.find((account) => account.id === thread.accountId)?.email ?? "";
  const account = from && (accounts?.length ?? 0) > 1 ? from : null;
  const chatThreadId = thread.chatThreadId ?? openedChatId;
  const showChat = chatOpen && chatThreadId !== null;
  const setChatOpen = async (open: boolean) => {
    if (!open || chatThreadId !== null) return onChatOpenChange(open);
    const result = await openSession.run({ threadId: thread.id });
    if (!result) return;
    setOpenedChatId(result.value.threadId);
    onChatOpenChange(true);
  };
  const showDetails = hasDetails(thread, detail, account);
  const detailsOpen = showDetails && !showChat && (wide ? widePanel : narrowPanel);
  const toggleDetails = () => {
    if (showChat) {
      onChatOpenChange(false);
      if (wide) setWidePanel(true);
      else setNarrowPanel(true);
    } else if (wide) setWidePanel(!widePanel);
    else setNarrowPanel(!narrowPanel);
  };
  const details = (
    <MailThreadDetails
      environmentId={environmentId}
      thread={thread}
      detail={detail}
      account={account}
      timestampFormat={timestampFormat}
      refresh={query.refresh}
      onDraftTask={setDraftTask}
    />
  );
  const messages = detail?.messages.toReversed() ?? [];
  return (
    <MailPage
      title={senderName(thread.from)}
      toolbar={
        <MailThreadToolbar
          environmentId={environmentId}
          thread={thread}
          canReply={canSaveDraft && detail !== null}
          onReply={() => setDraftTask({ kind: "edit", draft: null })}
          detailsOpen={detailsOpen}
          onToggleDetails={showDetails ? toggleDetails : null}
          chatOpen={showChat}
          chatDisabled={chatThreadId === null && openSession.disabled}
          onChatOpenChange={(open) => void setChatOpen(open)}
        />
      }
      scroll={false}
    >
      <div className="relative flex h-full min-h-0 gap-3 px-3 pb-3">
        <section
          aria-label={gt("Email")}
          className="scrollbar-gutter-both min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto rounded-2xl border border-border/70 bg-card"
        >
          <div className="mx-auto w-full max-w-3xl px-5 py-5 sm:px-8">
            <h1 className="mb-5 text-xl font-semibold wrap-anywhere">
              {thread.subject || gt("(No subject)")}
            </h1>
            {detail === null ? null : (
              <div className="divide-y divide-border/70">
                {messages.map((message, index) => (
                  <ThreadMessage
                    key={message.id + ":" + message.date}
                    environmentId={environmentId}
                    threadId={threadId}
                    message={message}
                    timestampFormat={timestampFormat}
                    eager={index === 0}
                  />
                ))}
              </div>
            )}
            {query.error && (
              <div
                role="alert"
                className="mt-4 flex items-center gap-2 text-sm text-destructive-foreground"
              >
                {query.error}
                <Button size="compact" variant="outline" onClick={query.refresh}>
                  {gt("Retry")}
                </Button>
              </div>
            )}
          </div>
        </section>
        {showChat ? (
          <aside
            aria-label={gt("Mail chat")}
            className={cn(
              "min-h-0 overflow-hidden rounded-2xl border border-border/70 bg-background",
              wide
                ? "w-[clamp(22rem,40%,36rem)] shrink-0"
                : "absolute inset-x-3 top-0 bottom-3 z-10 shadow-lg",
            )}
          >
            <MailChatPanel
              environmentId={environmentId}
              chatThreadId={chatThreadId}
              onClose={() => onChatOpenChange(false)}
            />
          </aside>
        ) : detailsOpen ? (
          <aside
            aria-label={gt("Mail details")}
            className={cn(
              "dropdown-glass min-h-0 w-72 shrink-0 self-start overflow-y-auto rounded-2xl",
              wide
                ? "max-h-full"
                : "absolute top-0 right-3 z-10 max-h-[calc(100%-0.75rem)] shadow-lg",
            )}
          >
            {details}
          </aside>
        ) : null}
        {draftTask && detail && (
          <MailDraftDialog
            environmentId={environmentId}
            detail={detail}
            from={from}
            refreshing={query.isPending || !!query.error}
            refresh={query.refresh}
            task={draftTask}
            close={() => setDraftTask(null)}
          />
        )}
      </div>
    </MailPage>
  );
}
