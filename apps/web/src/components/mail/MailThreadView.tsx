import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MailAddress,
  MailMessage,
  MailThreadDetail,
  MailThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Link } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { PaperclipIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { observeIntersection } from "../../lib/observeIntersection";
import { MailFormattedMessage } from "./MailFormattedMessage";
import { formatBytes } from "../../lib/formatBytes";
import { mailEnvironment } from "../../state/mail";
import { useEnvironmentQuery } from "../../state/query";
import { formatDateTimeTimestamp } from "../../timestampFormat";
import { useMailCommand } from "../settings/MailSettings.commands";
import { Button, InlineButton } from "../ui/button";
import {
  actionLabel,
  actorLabel,
  guardrailLabel,
  nudgeLabel,
  settleReasonLabel,
} from "./mailPresentation";
import { MailThreadControls } from "./MailThreadControls";
import { MailThreadDrafts } from "./MailThreadDrafts";

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
}: {
  message: MailMessage;
  threadId: MailThreadId;
  environmentId: EnvironmentId;
  timestampFormat: TimestampFormat;
}) {
  const gt = useGT();
  const [showCleaned, setShowCleaned] = useState(false);
  const [visible, setVisible] = useState(false);
  const observe = (node: HTMLElement | null) => {
    if (node === null || visible) return;
    return observeIntersection(
      node,
      (entry) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { rootMargin: "150px" },
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
  const body = showCleaned ? message.text : message.fullText || message.text;
  return (
    <article
      ref={observe}
      className="min-w-0 space-y-2 border-t border-border py-4 [content-visibility:auto]"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="min-w-0 text-sm font-semibold wrap-anywhere">{address(message.from)}</span>
        <time dateTime={message.date} className="text-xs text-muted-foreground">
          {formatDateTimeTimestamp(message.date, timestampFormat)}
        </time>
      </header>
      <div className="text-xs wrap-anywhere text-muted-foreground">
        {message.to.length > 0 && (
          <p>{gt("To: {recipients}", { recipients: message.to.map(address).join(", ") })}</p>
        )}
        {message.cc.length > 0 && (
          <p>{gt("Cc: {recipients}", { recipients: message.cc.map(address).join(", ") })}</p>
        )}
      </div>
      {formatted && !showCleaned ? (
        <MailFormattedMessage body={formatted} title={message.subject || gt("(No subject)")} />
      ) : (
        <p className="text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
          {body ?? gt("Message body unavailable.")}
        </p>
      )}
      {message.text && (formatted || (message.fullText && message.fullText !== message.text)) && (
        <InlineButton
          tone="muted"
          aria-pressed={showCleaned}
          onClick={() => setShowCleaned(!showCleaned)}
        >
          {showCleaned ? gt("Show original message") : gt("Show cleaned message")}
        </InlineButton>
      )}
      {message.attachments.length > 0 && (
        <ul aria-label={gt("Attachments")} className="space-y-1 text-xs text-muted-foreground">
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
  if (!actions.length) return null;
  return (
    <details className="border-t border-border pt-3">
      <summary className="cursor-pointer text-sm font-medium">{gt("Recent actions")}</summary>
      <ol className="mt-2 divide-y divide-border">
        {actions.map((entry) => (
          <li key={entry.id} className="flex items-center justify-between gap-2 py-2 text-xs">
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
    </details>
  );
}

export function MailThreadView({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: MailThreadId;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const query = useEnvironmentQuery(
    mailEnvironment.thread({ environmentId, input: { threadId } }),
    resolve,
  );
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const detail = query.data;
  const accounts = useAtomValue(
    mailEnvironment.view(environmentId),
    (view) => view?.status.accounts,
  );
  if (!detail) {
    return (
      <div className="space-y-3 p-6 text-sm text-muted-foreground">
        <p role="status">{query.error ?? gt("Loading email…")}</p>
        {query.error && (
          <Button size="sm" variant="outline" onClick={query.refresh}>
            {gt("Retry")}
          </Button>
        )}
      </div>
    );
  }
  const { thread } = detail;
  const from = accounts?.find((account) => account.id === thread.accountId)?.email ?? "";
  const showAccount = from && (accounts?.length ?? 0) > 1;
  const nudge = nudgeLabel(thread.nudge, resolve);
  return (
    <div
      key={JSON.stringify([environmentId, threadId])}
      className="mx-auto w-full max-w-3xl space-y-5 px-4 py-5 sm:px-8"
    >
      <header className="space-y-3">
        <h1 className="text-xl font-semibold wrap-anywhere">
          {thread.subject || gt("(No subject)")}
        </h1>
        {thread.line && thread.line.trim() !== thread.subject.trim() && (
          <p className="text-sm wrap-anywhere text-muted-foreground">{thread.line}</p>
        )}
        {thread.state === "settled" && thread.settledReason && (
          <p className="text-xs text-muted-foreground">
            {gt("Settled as {reason}", {
              reason: settleReasonLabel(thread.settledReason, resolve),
            })}
          </p>
        )}
        {thread.state === "snoozed" && (
          <p className="text-xs text-muted-foreground">
            {thread.snoozedUntil
              ? gt("Snoozed until {time}", {
                  time: formatDateTimeTimestamp(thread.snoozedUntil, timestampFormat),
                })
              : gt("Snoozed until reply")}
          </p>
        )}
        {thread.state === "working" && (
          <p className="text-xs text-muted-foreground">
            {thread.workingReason === "waiting" ? gt("Waiting for reply") : gt("Agent is drafting")}
          </p>
        )}
        {nudge && <p className="text-sm text-warning-foreground">{nudge}</p>}
        {thread.injectionWarning && (
          <p className="flex items-center gap-2 text-sm text-warning-foreground">
            <TriangleAlertIcon className="size-4 shrink-0" />
            {gt("This email reads like instructions to an AI.")}
          </p>
        )}
        <MailThreadControls environmentId={environmentId} thread={thread} />
      </header>
      <section aria-label={gt("Messages")}>
        {detail.messages.toReversed().map((message) => (
          <ThreadMessage
            key={message.id + ":" + message.date}
            environmentId={environmentId}
            threadId={threadId}
            message={message}
            timestampFormat={timestampFormat}
          />
        ))}
      </section>
      <MailThreadDrafts
        environmentId={environmentId}
        detail={detail}
        from={from}
        refreshing={query.isPending || !!query.error}
        refresh={query.refresh}
      />
      {detail.related.length > 0 && (
        <section className="space-y-2 border-t border-border pt-3">
          <h2 className="text-sm font-medium">{gt("Related mail")}</h2>
          <ul className="space-y-1">
            {detail.related.map((item) => (
              <li key={item.id}>
                <Link
                  to="/mail/$mailThreadId"
                  params={{ mailThreadId: item.id }}
                  className="flex items-baseline justify-between gap-3 rounded-sm py-1 text-sm hover:underline"
                >
                  <span className="min-w-0 truncate">{item.subject || gt("(No subject)")}</span>
                  <time
                    dateTime={item.lastMessageAt}
                    className="shrink-0 text-xs text-muted-foreground"
                  >
                    {formatDateTimeTimestamp(item.lastMessageAt, timestampFormat)}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(thread.guardrail || thread.suggestedAction || showAccount) && (
        <details className="border-t border-border pt-3">
          <summary className="cursor-pointer text-sm font-medium">{gt("Mail details")}</summary>
          <div className="mt-2 space-y-2 text-sm wrap-anywhere">
            {showAccount && (
              <dl>
                <dt className="text-xs text-muted-foreground">{gt("Account")}</dt>
                <dd>{from}</dd>
              </dl>
            )}
            {thread.suggestedAction && (
              <dl>
                <dt className="text-xs text-muted-foreground">{gt("Suggested next step")}</dt>
                <dd>{thread.suggestedAction}</dd>
              </dl>
            )}
            {thread.guardrail && (
              <p>
                {gt("Mail normally asks for review before settling messages marked “{reason}”.", {
                  reason: guardrailLabel(thread.guardrail, resolve),
                })}
              </p>
            )}
          </div>
        </details>
      )}
      <ActionLog
        environmentId={environmentId}
        actions={detail.actions}
        timestampFormat={timestampFormat}
        refresh={query.refresh}
      />
      {query.error && (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive-foreground">
          {query.error}
          <Button size="compact" variant="outline" onClick={query.refresh}>
            {gt("Retry")}
          </Button>
        </div>
      )}
    </div>
  );
}
