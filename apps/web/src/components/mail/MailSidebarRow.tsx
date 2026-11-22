import type { EnvironmentId, MailThreadRow } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  CheckIcon,
  CircleCheckIcon,
  PinIcon,
  BotIcon,
  SquarePenIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from "lucide-react";
import { memo, type MouseEvent } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatRelativeTime, formatShortTimestamp } from "../../timestampFormat";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { nudgeLabel, senderName, settleReasonLabel } from "./mailPresentation";
import type { useMailActions } from "./useMailActions";

function MailTime({ timestamp }: { timestamp: string }) {
  const nowMinute = useNowMinute();
  const resolve = useMessages();
  const parts = formatRelativeTime(timestamp, Date.parse(`${nowMinute}:00.000Z`), resolve);
  return parts === null ? null : <>{parts.value}</>;
}

const rowActionClassName =
  "pointer-events-none absolute inset-y-0 right-0 z-[2] inline-flex cursor-pointer items-center rounded-md px-1.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100";

export const MailSidebarRow = memo(function MailSidebarRow(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: MailThreadRow;
  readonly isActive: boolean;
  readonly actions: ReturnType<typeof useMailActions>;
}) {
  const { thread, isActive, actions } = props;
  const gt = useGT();
  const resolve = useMessages();
  const { isMobile, setOpenMobile } = useSidebar();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const stop = (event: MouseEvent) => event.stopPropagation();
  const sender = senderName(thread.from);
  const nudge = nudgeLabel(thread.nudge, resolve);
  const settledByAi = thread.state === "settled" && thread.settledBy === "ai";
  const quiet = thread.state === "settled" && !isActive;

  const rowAction =
    thread.state === "settled" ? (
      <button
        type="button"
        disabled={actions.disabled}
        aria-label={gt("Move back to Active")}
        className={rowActionClassName}
        onClick={(event) => {
          stop(event);
          void actions.act([thread.id], { type: "unsettle" }, gt("Moved back to Active"));
        }}
      >
        <Undo2Icon className="size-3.5" />
      </button>
    ) : thread.state === "snoozed" ? (
      <button
        type="button"
        disabled={actions.disabled}
        aria-label={gt("Wake now")}
        className={rowActionClassName}
        onClick={(event) => {
          stop(event);
          void actions.act([thread.id], { type: "unsnooze" });
        }}
      >
        <AlarmClockOffIcon className="size-3.5" />
      </button>
    ) : (
      <button
        type="button"
        disabled={actions.disabled}
        aria-label={gt("Settle")}
        className={rowActionClassName}
        onClick={(event) => {
          stop(event);
          void actions.act([thread.id], { type: "settle" }, gt("Settled"));
        }}
      >
        <CircleCheckIcon className="size-3.5" />
      </button>
    );

  return (
    <li className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_--spacing(13)]">
      <div
        data-mail-row={thread.id}
        className={cn(
          "group/sidebar-row relative flex w-full cursor-pointer flex-col justify-center gap-0.5 overflow-hidden rounded-md px-2.5 py-1.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <Link
          className="absolute inset-0 z-[1] rounded-md focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          to="/mail/$mailThreadId"
          params={{ mailThreadId: thread.id }}
          aria-label={`${sender}: ${thread.subject}`}
          aria-current={isActive ? "page" : undefined}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        />
        <div className="flex h-5 min-w-0 items-center gap-1.5">
          {thread.unread && thread.state !== "settled" ? (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
          ) : null}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              thread.unread && !quiet ? "font-semibold text-foreground" : "font-medium",
              quiet && "text-foreground/75",
            )}
          >
            {sender}
            {thread.messageCount > 1 ? (
              <span className="ms-1 font-normal text-secondary-label tabular-nums">
                {thread.messageCount}
              </span>
            ) : null}
          </span>
          {thread.injectionWarning ? (
            <TriangleAlertIcon
              aria-label={gt("Reads like instructions to an AI")}
              className="size-3 shrink-0 text-warning"
            />
          ) : null}
          {thread.hasDraft ? (
            <SquarePenIcon aria-label={gt("Draft")} className="size-3 shrink-0 text-warning" />
          ) : null}
          {thread.pinnedAt !== null ? (
            <PinIcon aria-label={gt("Pinned")} className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
          {settledByAi ? (
            <BotIcon
              aria-label={gt("Settled by AI")}
              className="size-3 shrink-0 text-muted-foreground"
            />
          ) : null}
          <span className="relative ml-auto flex h-5 min-w-8 shrink-0 items-center justify-end">
            <span className="text-xs text-secondary-label tabular-nums transition-opacity group-hover/sidebar-row:opacity-0">
              {thread.state === "snoozed" && thread.snoozedUntil !== null ? (
                <span className="inline-flex items-center gap-1 text-info-foreground">
                  <AlarmClockIcon aria-hidden className="size-3" />
                  {formatShortTimestamp(thread.snoozedUntil, timestampFormat)}
                </span>
              ) : (
                <MailTime timestamp={thread.lastMessageAt} />
              )}
            </span>
            {rowAction}
          </span>
        </div>
        <div className="flex h-4 min-w-0 items-center gap-1.5 text-xs">
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              nudge !== null ? "text-warning-foreground" : "text-secondary-label",
            )}
          >
            {nudge ?? thread.line}
          </span>
          {thread.state === "active" && thread.suggestion !== null ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    disabled={actions.disabled}
                    onClick={(event) => {
                      stop(event);
                      void actions.act([thread.id], { type: "approve" }, gt("Settled"));
                    }}
                    className="relative z-[2] inline-flex h-4 shrink-0 cursor-pointer items-center gap-0.5 rounded-sm border border-border px-1 text-2xs font-medium text-muted-foreground hover:border-primary/40 hover:text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
                  />
                }
              >
                <CheckIcon aria-hidden className="size-2.5" />
                {settleReasonLabel(thread.suggestion.reason, resolve)}
              </TooltipTrigger>
              <TooltipPopup side="top">
                <T>Settle as suggested</T>
              </TooltipPopup>
            </Tooltip>
          ) : thread.state === "active" && thread.suggestedAction ? (
            <span className="shrink-0 text-2xs text-muted-foreground">
              {thread.suggestedAction}
            </span>
          ) : thread.state === "settled" && thread.settledReason !== null ? (
            <span className="shrink-0 text-2xs text-muted-foreground">
              {settleReasonLabel(thread.settledReason, resolve)}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
});
