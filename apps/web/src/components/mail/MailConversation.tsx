import type {
  EnvironmentId,
  MailAddress,
  MailDraft,
  MailMessage,
  MailThreadDetail,
  MailThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { useGT } from "gt-react";
import { ForwardIcon, PaperclipIcon, ReplyAllIcon, ReplyIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { observeIntersection } from "../../lib/observeIntersection";
import { cn } from "../../lib/utils";
import { mailEnvironment } from "../../state/mail";
import { useEnvironmentQuery } from "../../state/query";
import { formatDateTimeTimestamp, formatShortTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type ComposeMode,
  draftTarget,
  hasOtherRecipients,
  isForward,
  isMine,
  messageSnippet,
} from "./mailCompose.logic";
import {
  MailFormattedMessage,
  QuotedToggle,
  rememberedMessageHeight,
} from "./MailFormattedMessage";
import { MailDraftRow } from "./MailThreadDrafts";

/** Older messages beyond these stay folded into one "more messages" row until asked for. */
const ALWAYS_SHOWN_AT_END = 2;

function useNames(mine: ReadonlyArray<string>) {
  const gt = useGT();
  const name = (entry: MailAddress) =>
    isMine(entry.address, mine) ? gt("me") : entry.name || entry.address;
  const full = (entry: MailAddress) =>
    entry.name && entry.name !== entry.address ? `${entry.name} <${entry.address}>` : entry.address;
  return { name, full };
}

function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-xs" variant="ghost-muted" aria-label={label} onClick={onClick} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function MessageBody({
  message,
  threadId,
  environmentId,
  eager,
}: {
  message: MailMessage;
  threadId: MailThreadId;
  environmentId: EnvironmentId;
  eager: boolean;
}) {
  const gt = useGT();
  const [visible, setVisible] = useState(eager);
  const [showQuoted, setShowQuoted] = useState(false);
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
  // Plain text shows only once the formatted body is known to be missing, never as a placeholder.
  const settled = display.isSuccess || display.error !== null;
  const trimmed =
    message.text !== null && message.fullText !== null && message.text !== message.fullText;
  return (
    <div ref={observe}>
      {!settled ? (
        <div aria-hidden style={{ height: rememberedMessageHeight(message.id) ?? 0 }} />
      ) : display.data ? (
        <MailFormattedMessage
          id={message.id}
          body={display.data}
          title={message.subject || gt("(No subject)")}
        />
      ) : (
        <>
          <p className="text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
            {(trimmed && !showQuoted ? message.text : (message.fullText ?? message.text)) ??
              gt("Message body unavailable.")}
          </p>
          {trimmed ? (
            <div className="mt-2">
              <QuotedToggle shown={showQuoted} onToggle={() => setShowQuoted(!showQuoted)} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function ThreadMessage({
  message,
  threadId,
  environmentId,
  timestampFormat,
  mine,
  expanded,
  eager,
  canReply,
  onToggle,
  onCompose,
}: {
  message: MailMessage;
  threadId: MailThreadId;
  environmentId: EnvironmentId;
  timestampFormat: TimestampFormat;
  mine: ReadonlyArray<string>;
  expanded: boolean;
  eager: boolean;
  canReply: boolean;
  onToggle: (() => void) | null;
  onCompose: (mode: ComposeMode) => void;
}) {
  const gt = useGT();
  const { name, full } = useNames(mine);
  const sender = message.outgoing ? gt("You") : message.from.name || message.from.address;
  const forwarded = isForward(message);
  const toNames = message.to.map(name).join(", ");
  const ccNames = message.cc.map(name).join(", ");
  const recipients = [
    toNames && gt("to {names}", { names: toNames }),
    ccNames && gt("cc {names}", { names: ccNames }),
  ]
    .filter(Boolean)
    .join(" · ");
  const everyone = [...message.to, ...message.cc].map(full).join(", ");

  if (!expanded) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={onToggle ?? undefined}
        className="-mx-2 flex w-[calc(100%+1rem)] min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-2.5 text-left text-sm hover:bg-accent/60"
      >
        <span className={cn("w-36 shrink-0 truncate", message.unread && "font-semibold")}>
          {sender}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {forwarded ? (
            <span className="text-foreground/80">
              {gt("Forwarded to {names}:", { names: toNames })}{" "}
            </span>
          ) : message.outgoing && toNames ? (
            <span className="text-foreground/80">{gt("To {names}:", { names: toNames })} </span>
          ) : null}
          {messageSnippet(message)}
        </span>
        {message.attachments.length > 0 ? (
          <PaperclipIcon
            aria-label={gt("Has attachments")}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        ) : null}
        <time dateTime={message.date} className="shrink-0 text-xs text-muted-foreground">
          {formatShortTimestamp(message.date, timestampFormat)}
        </time>
      </button>
    );
  }

  return (
    <article aria-label={gt("Message from {sender}", { sender })} className="min-w-0 py-4">
      <header className="mb-3 flex items-start gap-2">
        <button
          type="button"
          aria-expanded
          disabled={onToggle === null}
          onClick={onToggle ?? undefined}
          className="min-w-0 flex-1 cursor-pointer text-left disabled:cursor-default"
        >
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold">{sender}</span>
            {message.outgoing ? null : (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {message.from.address}
              </span>
            )}
            {forwarded ? (
              <span className="text-xs font-medium text-muted-foreground">{gt("Forwarded")}</span>
            ) : null}
          </span>
          {recipients ? (
            <Tooltip>
              <TooltipTrigger
                render={<span className="block truncate text-xs text-muted-foreground" />}
              >
                {recipients}
              </TooltipTrigger>
              <TooltipPopup side="bottom">{everyone}</TooltipPopup>
            </Tooltip>
          ) : null}
        </button>
        <time dateTime={message.date} className="shrink-0 pt-0.5 text-xs text-muted-foreground">
          {formatDateTimeTimestamp(message.date, timestampFormat)}
        </time>
        {canReply ? (
          <div className="-mt-0.5 flex shrink-0 items-center">
            <ActionButton label={gt("Reply")} onClick={() => onCompose("reply")}>
              <ReplyIcon />
            </ActionButton>
            {hasOtherRecipients(message, mine) ? (
              <ActionButton label={gt("Reply all")} onClick={() => onCompose("replyAll")}>
                <ReplyAllIcon />
              </ActionButton>
            ) : null}
            <ActionButton label={gt("Forward")} onClick={() => onCompose("forward")}>
              <ForwardIcon />
            </ActionButton>
          </div>
        ) : null}
      </header>
      <MessageBody
        message={message}
        threadId={threadId}
        environmentId={environmentId}
        eager={eager}
      />
      {message.attachments.length > 0 && (
        <ul aria-label={gt("Attachments")} className="mt-3 flex flex-wrap gap-1.5 text-xs">
          {message.attachments.map((file, index) => (
            <li
              // oxlint-disable-next-line react/no-array-index-key -- MIME parts have fixed order and can share identical metadata.
              key={index}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2 py-1 text-muted-foreground"
            >
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

/**
 * The conversation oldest first, like Gmail: the newest and unread messages open, older ones
 * folded to a line, and each reply or draft placed under the message it answers.
 */
export function MailConversation({
  environmentId,
  detail,
  mine,
  timestampFormat,
  canReply,
  composeTargetId,
  openDraftId,
  renderComposer,
  onCompose,
  onOpenDraft,
}: {
  environmentId: EnvironmentId;
  detail: MailThreadDetail;
  mine: ReadonlyArray<string>;
  timestampFormat: TimestampFormat;
  canReply: boolean;
  composeTargetId: string | null;
  openDraftId: string | null;
  renderComposer: () => ReactNode;
  onCompose: (mode: ComposeMode, target: MailMessage) => void;
  onOpenDraft: (draft: MailDraft) => void;
}) {
  const gt = useGT();
  const messages = detail.messages;
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [showAll, setShowAll] = useState(false);
  // Opening the thread marks it read, so what was unread on arrival stays open for this visit.
  const [arrivedUnread] = useState(
    () => new Set(messages.filter((message) => message.unread).map((message) => message.id)),
  );
  const newestId = messages.at(-1)?.id ?? null;
  const drafts = new Map<string, Array<MailDraft>>();
  for (const draft of detail.drafts) {
    if (draft.status === "sent" || draft.id === openDraftId) continue;
    const target = draftTarget(draft, messages);
    if (!target) continue;
    drafts.set(target.id, [...(drafts.get(target.id) ?? []), draft]);
  }
  const isExpanded = (message: MailMessage) =>
    toggled.get(message.id) ??
    (message.id === newestId || arrivedUnread.has(message.id) || message.id === composeTargetId);
  const pinned = (message: MailMessage, index: number) =>
    index === 0 ||
    index >= messages.length - ALWAYS_SHOWN_AT_END ||
    isExpanded(message) ||
    message.id === composeTargetId ||
    drafts.has(message.id);
  const hiddenIndexes = showAll
    ? []
    : messages.flatMap((message, index) => (pinned(message, index) ? [] : [index]));
  // One fold for two or more; a single hidden line is cheaper to show than a button.
  const fold = hiddenIndexes.length >= 2;
  const foldAt = hiddenIndexes[0];

  return (
    <div className="divide-y divide-border/70">
      {messages.map((message, index) => {
        if (fold && !pinned(message, index)) {
          if (index !== foldAt) return null;
          return (
            <div key="fold" className="py-1.5">
              <Button
                size="xs"
                variant="ghost-muted"
                className="w-full"
                onClick={() => setShowAll(true)}
              >
                {gt("{count, plural, one {# more message} other {# more messages}}", {
                  count: hiddenIndexes.length,
                })}
              </Button>
            </div>
          );
        }
        const expanded = isExpanded(message);
        return (
          <Fragment key={message.id}>
            <div>
              <ThreadMessage
                message={message}
                threadId={detail.thread.id}
                environmentId={environmentId}
                timestampFormat={timestampFormat}
                mine={mine}
                expanded={expanded}
                eager={message.id === newestId}
                canReply={canReply}
                onToggle={
                  messages.length === 1
                    ? null
                    : () => setToggled(new Map(toggled).set(message.id, !expanded))
                }
                onCompose={(mode) => onCompose(mode, message)}
              />
              {(drafts.get(message.id) ?? []).map((draft) => (
                <MailDraftRow
                  key={draft.id}
                  draft={draft}
                  disabled={!canReply}
                  onOpen={() => onOpenDraft(draft)}
                />
              ))}
              {composeTargetId === message.id ? renderComposer() : null}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
