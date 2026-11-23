import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MailDraft,
  MailRule,
  MailThreadAction,
  MailThreadDetail,
  MailThreadId,
  MailThreadRow,
  ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Link } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { CheckIcon, ListFilterPlusIcon, TriangleAlertIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useState, type ReactNode } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { mailEnvironment } from "../../state/mail";
import { useEnvironmentQuery } from "../../state/query";
import { formatDateTimeTimestamp } from "../../timestampFormat";
import { useMailCommand } from "../settings/MailSettings.commands";
import { newRule, RuleDialog, useRuleSummary, useSaveRule } from "../settings/MailSettings.rules";
import { Button } from "../ui/button";
import { MailChatAside } from "./MailChatPanel";
import { type ComposeTask, MailComposer } from "./MailComposer";
import { MailConversation } from "./MailConversation";
import { MailDecider } from "./MailDecider";
import { mailDecision, threadAutoSettleRules } from "./mailDecision";
import {
  type ComposeMode,
  defaultReplyTarget,
  draftMode,
  draftTarget,
  hasOtherRecipients,
} from "./mailCompose.logic";
import { actionLabel, actorLabel, nudgeLabel, senderName } from "./mailPresentation";
import { MailNewEmail } from "./MailNewEmail";
import { MailPage } from "./MailPage";
import { MailThreadToolbar } from "./MailThreadControls";
import { MailThreadLabels } from "./MailLabels";
import { useMailActions } from "./useMailActions";
import { useSenderAi } from "./useSenderAi";

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
  autoSettle,
  labels,
  timestampFormat,
  refresh,
}: {
  environmentId: EnvironmentId;
  thread: MailThreadRow;
  detail: MailThreadDetail | null;
  account: string | null;
  autoSettle: ReactNode;
  labels: ReactNode;
  timestampFormat: TimestampFormat;
  refresh: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const senderAi = useSenderAi(environmentId);
  const aiEntry = senderAi.entryFor(thread.from.address);
  const aiOff = aiEntry !== null;
  const decision = mailDecision(thread);
  const nudge = nudgeLabel(thread.nudge, resolve);
  const decisionText =
    decision?.why ??
    (decision?.actor === "rule"
      ? thread.state === "settled"
        ? gt("Settled by your rule")
        : gt("Suggested by your rule")
      : decision && thread.state === "settled"
        ? gt("Settled by AI")
        : null);
  const status =
    thread.state === "settled"
      ? gt("Settled", { $context: "email state" })
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
    aiOff ||
    decisionText !== null ||
    nudge !== null ||
    thread.injectionWarning ||
    (!thread.suggestion && thread.suggestedAction !== null) ||
    account !== null;
  return (
    <>
      {hasStatus ? (
        <DetailsSection>
          <div className="space-y-2 text-sm wrap-anywhere">
            {status ? <p>{status}</p> : null}
            {decision && decisionText ? (
              <p className="flex items-start gap-1.5 text-muted-foreground">
                <span className="flex h-5 shrink-0 items-center">
                  <MailDecider
                    environmentId={environmentId}
                    actor={decision.actor}
                    decidedBy={thread.decidedBy}
                  />
                </span>
                {decisionText}
              </p>
            ) : null}
            {aiOff ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-muted-foreground">
                  {aiEntry?.toLowerCase() === thread.from.address.toLowerCase()
                    ? gt("AI is off for this sender.")
                    : gt("AI is off for {sender}.", { sender: aiEntry ?? "" })}
                </p>
                {senderAi.disabled ? null : (
                  <Button
                    size="compact"
                    variant="outline"
                    onClick={() => void senderAi.toggle(thread.from.address)}
                  >
                    {gt("Turn on")}
                  </Button>
                )}
              </div>
            ) : null}
            {nudge ? <p className="text-warning-foreground">{nudge}</p> : null}
            {thread.injectionWarning ? (
              <p className="flex items-center gap-1.5 text-warning-foreground">
                <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                {gt("This email reads like instructions to an AI.")}
              </p>
            ) : null}
            {!thread.suggestion && thread.suggestedAction ? (
              <dl>
                <dt className="text-xs text-muted-foreground">{gt("Suggested next step")}</dt>
                <dd>{thread.suggestedAction}</dd>
              </dl>
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
      {autoSettle}
      {labels}
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

function AutoSettleSection({
  environmentId,
  matching,
  ready,
  onOpen,
}: {
  environmentId: EnvironmentId;
  matching: ReturnType<typeof threadAutoSettleRules>;
  ready: boolean;
  onOpen: (rule: MailRule | null) => void;
}) {
  const gt = useGT();
  const summary = useRuleSummary();
  const command = useSaveRule(environmentId);
  const disabled = !ready || command.disabled;
  const remove = async (rule: MailRule) => {
    const message = gt("Remove this auto-settle rule for all matching mail?");
    if (
      await (requestConfirmDialog(message, { variant: "destructive" }) ?? window.confirm(message))
    ) {
      await command.run({ ruleId: rule.id, delete: true });
    }
  };
  return (
    <DetailsSection>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {matching.inScope.length ? (
            gt("Auto-settle")
          ) : (
            <Button
              size="compact"
              variant="outline"
              disabled={disabled}
              onClick={() => onOpen(null)}
            >
              <ListFilterPlusIcon aria-hidden />
              {gt("Auto-settle")}
            </Button>
          )}
        </h2>
        {ready ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            {matching.applied && <CheckIcon aria-hidden className="size-3" />}
            {matching.applied ? gt("On") : matching.inScope.length ? gt("Conditional") : gt("Off")}
          </span>
        ) : null}
      </div>
      {matching.inScope.map((rule) => (
        <div key={rule.id} className="space-y-1.5 py-1.5 [&+&]:border-t [&+&]:border-border/60">
          <p className="text-sm wrap-anywhere">{summary(rule)}</p>
          {rule.when && (
            <p className="text-xs wrap-anywhere text-muted-foreground">
              {gt("Only when: {when}", { when: rule.when })}
            </p>
          )}
          <div className="flex items-center gap-1">
            <Button
              size="compact"
              variant="outline"
              disabled={disabled}
              onClick={() => onOpen(rule)}
            >
              {gt("Edit rule")}
            </Button>
            <Button
              size="compact"
              variant="ghost"
              disabled={disabled}
              onClick={() => void remove(rule)}
            >
              {gt("Remove")}
            </Button>
          </div>
        </div>
      ))}
      {matching.inScope.length > 0 && matching.applied === null && (
        <Button size="compact" variant="outline" disabled={disabled} onClick={() => onOpen(null)}>
          {gt("Add rule")}
        </Button>
      )}
    </DetailsSection>
  );
}

function ThreadRuleDialog({
  environmentId,
  existing,
  sender,
  detail,
  onClose,
}: {
  environmentId: EnvironmentId;
  existing: MailRule | null;
  sender: string;
  detail: MailThreadDetail;
  onClose: () => void;
}) {
  const gt = useGT();
  const saveRule = useSaveRule(environmentId);
  const actions = useMailActions(environmentId);
  // Capture the suggestion revision and rule the user opened, even if fresh mail arrives.
  const [editor] = useState(() => {
    const { thread } = detail;
    const action: MailThreadAction | null =
      existing || thread.state === "settled" || actions.disabled
        ? null
        : thread.suggestion
          ? { type: "approve", revisions: { [thread.id]: thread.suggestion.revision } }
          : { type: "settle" };
    return {
      action,
      editing: existing !== null,
      initial:
        existing ??
        newRule({
          match: sender ? { from: `<${sender}>` } : {},
          when: detail.kind ?? "",
          reason: thread.suggestion?.reason ?? "fyi",
        }),
    };
  });
  return (
    <RuleDialog
      environmentId={environmentId}
      initial={editor.initial}
      title={editor.editing ? gt("Edit rule") : gt("Auto-settle")}
      {...(editor.action ? { saveLabel: gt("Save and settle") } : {})}
      disabled={saveRule.disabled || (editor.action !== null && actions.disabled)}
      onClose={onClose}
      onSave={async (saved) => {
        if (!(await saveRule.save(saved, editor.editing))) return;
        onClose();
        if (editor.action) await actions.act([detail.thread.id], editor.action, gt("Settled"));
      }}
    />
  );
}

export function MailThreadView({
  environmentId,
  threadId,
  chatOpen,
  onChatOpenChange,
  ruleOpen,
  onRuleOpenChange,
  requestedCompose,
  onComposeHandled,
}: {
  environmentId: EnvironmentId;
  threadId: MailThreadId;
  chatOpen: boolean;
  onChatOpenChange: (open: boolean) => void;
  /** Reply or Forward chosen from the sidebar menu before the email opened. */
  requestedCompose: ComposeMode | null;
  ruleOpen: boolean | string;
  onRuleOpenChange: (open: boolean | string) => void;
  onComposeHandled: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const query = useEnvironmentQuery(
    mailEnvironment.thread({ environmentId, input: { threadId, includeSpamAndUnsubscribe: true } }),
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
  const canSaveRule = useAtomValue(mailEnvironment.saveRule.permissionAtom(environmentId));
  const senderAi = useSenderAi(environmentId);
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
  if (thread.messageCount === 0) {
    return (
      <MailNewEmail
        environmentId={environmentId}
        thread={thread}
        detail={detail}
        chatOpen={chatOpen}
        onChatOpenChange={onChatOpenChange}
      />
    );
  }
  const mailAccount = accounts?.find((account) => account.id === thread.accountId);
  const from = mailAccount?.email ?? "";
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
  const aiOff = senderAi.entryFor(thread.from.address) !== null;
  const rules = view?.status.settings.rules;
  const matching = threadAutoSettleRules(rules ?? [], replyTarget, thread.ruleId);
  const existing =
    typeof ruleOpen === "string" ? rules?.find((entry) => entry.id === ruleOpen) : matching.applied;
  const detailsOpen = !showChat && (wide ? widePanel : narrowPanel);
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
      labels={
        mailAccount &&
        detail?.labels && (
          <MailThreadLabels
            key={thread.id}
            environmentId={environmentId}
            threadId={thread.id}
            labels={detail.labels}
            account={mailAccount}
            refresh={query.refresh}
          />
        )
      }
      autoSettle={
        <AutoSettleSection
          environmentId={environmentId}
          matching={matching}
          ready={Boolean(rules && detail)}
          onOpen={(rule) => onRuleOpenChange(rule?.id ?? true)}
        />
      }
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
          hasRule={matching.applied !== null}
          ruleDisabled={!detail || !rules || !canSaveRule}
          onOpenRule={() => onRuleOpenChange(true)}
          canReply={canReply && replyTarget !== null}
          canReplyAll={replyTarget !== null && hasOtherRecipients(replyTarget, mine)}
          supportsSpam={view?.status.capabilities?.spam === true}
          canUnsubscribe={detail?.canUnsubscribe ?? false}
          onCompose={(mode) =>
            replyTarget && openCompose({ mode, targetId: replyTarget.id, draft: null })
          }
          detailsOpen={detailsOpen}
          onToggleDetails={toggleDetails}
          chatOpen={showChat}
          // An open chat can still be closed after AI is turned off for the sender.
          chatDisabled={(chatThreadId === null && openSession.disabled) || (aiOff && !showChat)}
          onChatOpenChange={(open) => void setChatOpen(open)}
        />
      }
      scroll={false}
    >
      {ruleOpen && rules && detail && existing !== undefined ? (
        <ThreadRuleDialog
          environmentId={environmentId}
          existing={existing}
          sender={replyTarget && !replyTarget.outgoing ? replyTarget.from.address : ""}
          detail={detail}
          onClose={() => onRuleOpenChange(false)}
        />
      ) : null}
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
          <MailChatAside
            environmentId={environmentId}
            chatThreadId={chatThreadId}
            wide={wide}
            onClose={() => onChatOpenChange(false)}
          />
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
