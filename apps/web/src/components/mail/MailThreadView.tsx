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
  timestampFormat,
}: {
  message: MailMessage;
  timestampFormat: TimestampFormat;
}) {
  const gt = useGT();
  const [original, setOriginal] = useState(false);
  const body = original ? message.fullText : message.text || message.fullText;
  return (
    <article className="space-y-2 border-t border-border py-4 [content-visibility:auto]">
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
      <p className="text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
        {body ?? gt("Message body unavailable.")}
      </p>
      {message.fullText && message.text && message.fullText !== message.text && (
        <InlineButton tone="muted" aria-pressed={original} onClick={() => setOriginal(!original)}>
          {original ? gt("Show cleaned message") : gt("Show original message")}
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
  const from = useAtomValue(
    mailEnvironment.view(environmentId),
    (view) =>
      view?.status.accounts.find((entry) => entry.id === detail?.thread.accountId)?.email ?? "",
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
  const nudge = nudgeLabel(thread.nudge, resolve);
  return (
    <div
      key={JSON.stringify([environmentId, threadId])}
      className="mx-auto w-full max-w-3xl space-y-5 px-4 py-5 sm:px-8"
    >
      <header className="space-y-3">
        {from && <p className="text-xs text-muted-foreground">{from}</p>}
        <h1 className="text-xl font-semibold wrap-anywhere">
          {thread.subject || gt("(No subject)")}
        </h1>
        {thread.line && (
          <p className="text-sm wrap-anywhere text-muted-foreground">{thread.line}</p>
        )}
        {thread.suggestedAction && <p className="text-sm">{thread.suggestedAction}</p>}
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
        {thread.guardrail && (
          <p className="text-sm text-muted-foreground">
            {guardrailLabel(thread.guardrail, resolve)}
          </p>
        )}
        {thread.injectionWarning && (
          <p className="flex items-center gap-2 text-sm text-warning-foreground">
            <TriangleAlertIcon className="size-4 shrink-0" />
            {gt("This email reads like instructions to an AI.")}
          </p>
        )}
        <MailThreadControls environmentId={environmentId} thread={thread} />
      </header>
      <section aria-label={gt("Messages")}>
        {detail.messages.map((message) => (
          <ThreadMessage key={message.id} message={message} timestampFormat={timestampFormat} />
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
