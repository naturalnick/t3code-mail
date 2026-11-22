import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MailDraft,
  MailThreadDetail,
  MailThreadId,
  MailThreadRow,
  ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Link } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { BotIcon, TriangleAlertIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useState, type ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { mailEnvironment } from "../../state/mail";
import { useEnvironmentQuery } from "../../state/query";
import { formatDateTimeTimestamp } from "../../timestampFormat";
import { useMailCommand } from "../settings/MailSettings.commands";
import { Button } from "../ui/button";
import { MailChatPanel } from "./MailChatPanel";
import { type ComposeTask, MailComposer } from "./MailComposer";
import { MailConversation } from "./MailConversation";
import {
  type ComposeMode,
  defaultReplyTarget,
  draftMode,
  draftTarget,
  hasOtherRecipients,
} from "./mailCompose.logic";
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
import { useMailActions } from "./useMailActions";

const DETAILS_PANEL_KEY = "t3code:mail-details-panel";

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
}: {
  environmentId: EnvironmentId;
  thread: MailThreadRow;
  detail: MailThreadDetail | null;
  account: string | null;
  timestampFormat: TimestampFormat;
  refresh: () => void;
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
    (detail !== null && (detail.related.length > 0 || detail.actions.length > 0))
  );
}

export function MailThreadView({
  environmentId,
  threadId,
  chatOpen,
  onChatOpenChange,
  requestedCompose,
  onComposeHandled,
}: {
  environmentId: EnvironmentId;
  threadId: MailThreadId;
  chatOpen: boolean;
  onChatOpenChange: (open: boolean) => void;
  /** Reply or Forward chosen from the sidebar menu before the email opened. */
  requestedCompose: ComposeMode | null;
  onComposeHandled: () => void;
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
  const [compose, setCompose] = useState<ComposeTask | null>(null);
  // The draft the open composer has saved, so its row is not listed twice.
  const [composeDraftId, setComposeDraftId] = useState<string | null>(null);
  const [seenRequest, setSeenRequest] = useState<ComposeMode | null>(null);
  const detail = query.data;
  const accounts = view?.status.accounts;
  const mine = accounts?.map((account) => account.email) ?? [];
  const openCompose = (task: ComposeTask) => {
    setCompose(task);
    setComposeDraftId(task.draft?.id ?? null);
  };
  const replyTarget = detail ? defaultReplyTarget(detail.messages) : null;
  // A menu request waits for the messages, since it answers the newest one someone else sent.
  if (requestedCompose !== seenRequest && (requestedCompose === null || replyTarget !== null)) {
    setSeenRequest(requestedCompose);
    if (requestedCompose !== null && replyTarget !== null) {
      // The sidebar menu cannot see recipients; Reply all with no one else is a Reply.
      const mode =
        requestedCompose === "replyAll" && !hasOtherRecipients(replyTarget, mine)
          ? "reply"
          : requestedCompose;
      openCompose({ mode, targetId: replyTarget.id, draft: null });
    }
  }
  const closeCompose = () => {
    setCompose(null);
    setComposeDraftId(null);
    if (requestedCompose !== null) onComposeHandled();
  };
  // The row learns its chat id on the next snapshot; the reply to opening one knows it now.
  const [openedChatId, setOpenedChatId] = useState<ThreadId | null>(null);
  const openSession = useMailCommand(
    environmentId,
    mailEnvironment.openSession,
    gt("Could not open mail chat"),
  );
  const canSaveDraft = useAtomValue(mailEnvironment.saveDraft.permissionAtom(environmentId));
  // The sidebar row is already in memory, so the header paints before the thread arrives.
  const thread = detail?.thread ?? view?.threads.get(threadId) ?? null;
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
    />
  );
  const canReply = canSaveDraft && detail !== null;
  const composeTarget =
    compose && detail
      ? (detail.messages.find((item) => item.id === compose.targetId) ?? null)
      : null;
  const openDraft = (draft: MailDraft) => {
    const target = detail && draftTarget(draft, detail.messages);
    if (target) openCompose({ mode: draftMode(draft), targetId: target.id, draft });
  };
  return (
    <MailPage
      title={senderName(thread.from)}
      toolbar={
        <MailThreadToolbar
          environmentId={environmentId}
          thread={thread}
          canReply={canReply && replyTarget !== null}
          canReplyAll={replyTarget !== null && hasOtherRecipients(replyTarget, mine)}
          onCompose={(mode) =>
            replyTarget && openCompose({ mode, targetId: replyTarget.id, draft: null })
          }
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
          <div className="px-4 py-4 sm:px-5">
            <h1 className="mb-5 text-xl font-semibold wrap-anywhere">
              {thread.subject || gt("(No subject)")}
            </h1>
            {detail === null ? null : (
              <MailConversation
                environmentId={environmentId}
                detail={detail}
                mine={mine}
                timestampFormat={timestampFormat}
                canReply={canReply}
                composeTargetId={composeTarget?.id ?? null}
                openDraftId={composeDraftId}
                renderComposer={() =>
                  compose && composeTarget ? (
                    <MailComposer
                      key={`${compose.targetId}:${compose.mode}:${compose.draft?.id ?? ""}`}
                      environmentId={environmentId}
                      detail={detail}
                      target={composeTarget}
                      mine={mine}
                      from={from}
                      timestampFormat={timestampFormat}
                      refresh={query.refresh}
                      task={compose}
                      onSaved={(draft) => setComposeDraftId(draft.id)}
                      close={closeCompose}
                    />
                  ) : null
                }
                onCompose={(mode, target) =>
                  openCompose({ mode, targetId: target.id, draft: null })
                }
                onOpenDraft={openDraft}
              />
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
      </div>
    </MailPage>
  );
}
