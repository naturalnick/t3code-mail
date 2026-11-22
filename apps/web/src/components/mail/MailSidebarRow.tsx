import type { EnvironmentId, MailThreadRow } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  CheckIcon,
  PinIcon,
  SquarePenIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from "lucide-react";
import { memo, useState, type MouseEvent } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatRelativeTime, formatShortTimestamp } from "../../timestampFormat";
import { SnoozeMenuButton } from "../sidebar/SidebarThreadRow";
import { MenuItem } from "../ui/menu";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MailDecider } from "./MailDecider";
import { mailDecision } from "./mailDecision";
import { nudgeLabel, senderName } from "./mailPresentation";
import type { useMailActions } from "./useMailActions";

function MailTime({ timestamp }: { timestamp: string }) {
  const nowMinute = useNowMinute();
  const resolve = useMessages();
  const parts = formatRelativeTime(timestamp, Date.parse(`${nowMinute}:00.000Z`), resolve);
  return parts === null ? null : <>{parts.value}</>;
}

const badgeClassName = "inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground";

const rowActionClassName =
  "inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground disabled:pointer-events-none";

export const MailSidebarRow = memo(function MailSidebarRow(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: MailThreadRow;
  readonly isActive: boolean;
  readonly actions: ReturnType<typeof useMailActions>;
  /** The time to show instead of the latest message's, such as when it was sent. */
  readonly timestamp?: string;
  readonly onIntent?: ((thread: MailThreadRow | null) => void) | undefined;
  readonly onContextMenu?: ((thread: MailThreadRow, event: MouseEvent) => void) | undefined;
}) {
  const { environmentId, thread, isActive, actions, timestamp, onIntent, onContextMenu } = props;
  const gt = useGT();
  const resolve = useMessages();
  const { isMobile, setOpenMobile } = useSidebar();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  const stop = (event: MouseEvent) => event.stopPropagation();
  // A new email not sent yet: named by who it goes to.
  const isNew = thread.messageCount === 0;
  const sender = isNew
    ? thread.from.address
      ? gt("To {recipient}", { recipient: senderName(thread.from) })
      : gt("New email")
    : senderName(thread.from);
  const subject = thread.subject || gt("(No subject)");
  const nudge = nudgeLabel(thread.nudge, resolve);
  const settled = thread.state === "settled";
  const recede = settled && !isActive;
  const unread = thread.unread && !settled;
  const suggestion = thread.state === "active" ? thread.suggestion : null;
  // Who sorted it, shown as an icon with the reason on hover. Decisions from before the model
  // gave reasons have nothing to say, so they show nothing.
  const sorted = suggestion !== null || settled ? mailDecision(thread) : null;
  const decision = sorted?.why || sorted?.actor === "rule" ? sorted : null;
  const decider = decision?.actor ?? null;
  // A settle suggestion already says what to do, so its next-step text would repeat it.
  const metaText =
    nudge ?? (thread.state === "active" && suggestion === null ? thread.suggestedAction : null);
  const badgeNote =
    decision?.why ?? (suggestion ? gt("Suggested by your rule") : gt("Settled by your rule"));

  const snooze = (until: string | null) =>
    void actions.act([thread.id], { type: "snooze", until, onReply: true }, gt("Snoozed"));
  const settle = (event: MouseEvent) => {
    stop(event);
    void actions.act(
      [thread.id],
      suggestion
        ? { type: "approve", revisions: { [thread.id]: suggestion.revision } }
        : { type: "settle" },
      gt("Settled"),
    );
  };

  const controls = isNew ? null : thread.state === "settled" ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={actions.disabled}
            aria-label={gt("Move back to Active")}
            className={rowActionClassName}
            onClick={(event) => {
              stop(event);
              void actions.act([thread.id], { type: "unsettle" }, gt("Moved back to Active"));
            }}
          />
        }
      >
        <Undo2Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <T>Move back to Active</T>
      </TooltipPopup>
    </Tooltip>
  ) : thread.state === "snoozed" ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={actions.disabled}
            aria-label={gt("Wake now")}
            className={rowActionClassName}
            onClick={(event) => {
              stop(event);
              void actions.act([thread.id], { type: "unsnooze" }, gt("Moved back to Active"));
            }}
          />
        }
      >
        <AlarmClockOffIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <T>Wake now</T>
      </TooltipPopup>
    </Tooltip>
  ) : actions.disabled ? null : (
    <>
      <SnoozeMenuButton
        open={snoozeMenuOpen}
        onOpenChange={setSnoozeMenuOpen}
        onSnooze={(preset) => snooze(preset.snoozedUntil)}
        timestampFormat={timestampFormat}
        environmentId={environmentId}
        label={gt("Snooze")}
        extraItems={
          <MenuItem
            onClick={(event) => {
              event.stopPropagation();
              snooze(null);
            }}
          >
            <T>Until reply</T>
          </MenuItem>
        }
      />
      <button type="button" className={cn(rowActionClassName, "-mr-1")} onClick={settle}>
        <CheckIcon className="size-3.5" />
        <T>Settle</T>
      </button>
    </>
  );

  return (
    <li className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_60px]">
      <div
        data-mail-row={thread.id}
        onPointerEnter={() => onIntent?.(thread)}
        onPointerLeave={() => onIntent?.(null)}
        onFocus={() => onIntent?.(thread)}
        onContextMenu={onContextMenu ? (event) => onContextMenu(thread, event) : undefined}
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md px-(--sidebar-row-content-inset) py-(--sidebar-content-inset) text-left outline-none select-none",
          isActive
            ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : recede
              ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <Link
          className="absolute inset-0 z-[1] rounded-md focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
          to="/mail/$mailThreadId"
          params={{ mailThreadId: thread.id }}
          aria-label={`${sender}: ${subject}`}
          aria-current={isActive ? "page" : undefined}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        />
        <div className="flex h-5 min-w-0 items-center gap-1.5">
          {unread ? (
            <span
              role="img"
              aria-label={gt("Unread")}
              className="size-1.5 shrink-0 rounded-full bg-primary"
            />
          ) : null}
          {thread.hasDraft ? (
            <SquarePenIcon aria-label={gt("Draft")} className="size-3 shrink-0 text-warning" />
          ) : null}
          {thread.pinnedAt !== null ? (
            <PinIcon
              aria-label={gt("Pinned")}
              className="size-3 shrink-0 text-muted-foreground/65"
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs text-secondary-label">
            {sender}
            {thread.messageCount > 1 ? (
              <span className="ms-1 tabular-nums">{thread.messageCount}</span>
            ) : null}
          </span>
          <span className="relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
            <span
              className={cn(
                "pointer-events-none flex items-center self-center tabular-nums text-secondary-label group-hover/sidebar-row:absolute group-hover/sidebar-row:right-0 group-hover/sidebar-row:opacity-0 group-has-[:focus-visible]/sidebar-row:absolute group-has-[:focus-visible]/sidebar-row:right-0 group-has-[:focus-visible]/sidebar-row:opacity-0",
                snoozeMenuOpen && "absolute right-0 opacity-0",
              )}
            >
              {thread.state === "snoozed" && thread.snoozedUntil !== null ? (
                <span className="inline-flex items-center gap-1 text-info-foreground">
                  <AlarmClockIcon aria-hidden className="size-3" />
                  {formatShortTimestamp(thread.snoozedUntil, timestampFormat)}
                </span>
              ) : (
                <MailTime timestamp={timestamp ?? thread.lastMessageAt} />
              )}
            </span>
            {controls === null ? null : (
              <span
                className={cn(
                  // Relative, not static, so the controls stay above the row link.
                  "pointer-events-none absolute inset-y-0 right-0 z-[2] flex items-stretch opacity-0 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:relative has-[:focus-visible]:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:relative group-hover/sidebar-row:opacity-100",
                  snoozeMenuOpen && "pointer-events-auto relative opacity-100",
                )}
              >
                {controls}
              </span>
            )}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              unread ? "font-semibold text-foreground" : recede ? "font-normal" : "font-medium",
              recede && "text-foreground/75 group-hover/sidebar-row:text-foreground",
            )}
          >
            {subject}
          </span>
          {thread.injectionWarning ? (
            <TriangleAlertIcon
              aria-label={gt("Reads like instructions to an AI")}
              className="size-3 shrink-0 text-warning"
            />
          ) : null}
        </div>
        {metaText !== null || decider !== null ? (
          <div className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-xs">
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                nudge !== null ? "text-warning-foreground" : "text-secondary-label",
              )}
            >
              {metaText}
            </span>
            {decider === null ? null : (
              <Tooltip>
                <TooltipTrigger
                  // Above the row link, so hovering the badge shows why.
                  render={<span className={cn(badgeClassName, "relative z-[2]")} />}
                >
                  <MailDecider
                    environmentId={environmentId}
                    actor={decider}
                    decidedBy={thread.decidedBy}
                  />
                </TooltipTrigger>
                <TooltipPopup side="top">{badgeNote}</TooltipPopup>
              </Tooltip>
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
});
