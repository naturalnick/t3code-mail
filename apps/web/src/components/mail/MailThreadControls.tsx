import type { EnvironmentId, MailThreadRow } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import {
  AlarmClockOffIcon,
  CheckIcon,
  ClockIcon,
  EllipsisIcon,
  ForwardIcon,
  MessageSquareIcon,
  ReplyAllIcon,
  ReplyIcon,
  SquareMenuIcon,
  Undo2Icon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { pickSnoozePreset, resolveSnoozePresets } from "../Sidebar.snooze";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuItemDetail, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposeMode } from "./mailCompose.logic";
import { settleReasonLabel } from "./mailPresentation";
import { useMailActions } from "./useMailActions";

function SnoozeMenu({
  environmentId,
  disabled,
  onSnooze,
}: {
  environmentId: EnvironmentId;
  disabled: boolean;
  onSnooze: (until: string | null) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        render={<Button size="sm" variant="ghost" aria-label={gt("Snooze")} />}
      >
        <ClockIcon />
        <T>Snooze</T>
      </MenuTrigger>
      <MenuPopup align="end">
        <SnoozePresetItems
          environmentId={environmentId}
          timestampFormat={timestampFormat}
          resolve={resolve}
          onSnooze={onSnooze}
        />
        <MenuItem onClick={() => onSnooze(null)}>
          <T>Until reply</T>
        </MenuItem>
        <MenuItem
          onClick={async () => {
            const choice = await requestCustomSnooze();
            if (choice) onSnooze(choice.snoozedUntil);
          }}
        >
          <T>Custom…</T>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Mounted only while the menu is open, so each opening reads a fresh time. */
function SnoozePresetItems({
  environmentId,
  timestampFormat,
  resolve,
  onSnooze,
}: {
  environmentId: EnvironmentId;
  timestampFormat: TimestampFormat;
  resolve: ReturnType<typeof useMessages>;
  onSnooze: (until: string) => void;
}) {
  // oxlint-disable-next-line react/purity -- The menu content mounts on open, so this reads the time the menu opened.
  const presets = resolveSnoozePresets(new Date(), timestampFormat, environmentId, resolve);
  if (presets.length === 0) return null;
  return (
    <>
      {presets.map((preset) => (
        <MenuItem
          key={preset.id}
          onClick={() => {
            const picked = pickSnoozePreset(presets, preset.id, timestampFormat, environmentId);
            if (picked) onSnooze(picked.snoozedUntil);
          }}
        >
          {preset.label}
          <MenuItemDetail>{preset.whenLabel}</MenuItemDetail>
        </MenuItem>
      ))}
      <MenuSeparator />
    </>
  );
}

export function MailThreadToolbar({
  environmentId,
  thread,
  canReply,
  canReplyAll,
  onCompose,
  detailsOpen,
  onToggleDetails,
  chatOpen,
  chatDisabled,
  onChatOpenChange,
}: {
  environmentId: EnvironmentId;
  thread: MailThreadRow;
  canReply: boolean;
  /** Whether the message Reply answers has anyone else on it. */
  canReplyAll: boolean;
  onCompose: (mode: ComposeMode) => void;
  detailsOpen: boolean;
  onToggleDetails: (() => void) | null;
  chatOpen: boolean;
  chatDisabled: boolean;
  onChatOpenChange: (open: boolean) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const { act, disabled } = useMailActions(environmentId);
  const navigate = useNavigate();
  const markRead = useEffectEvent(() => void act([thread.id], { type: "mark_read" }));
  const readAt = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Opening unread mail acknowledges it on the server.
  useEffect(() => {
    const opened = `${thread.id}/${thread.lastMessageAt}/${thread.messageCount}`;
    if (disabled || readAt.current === opened) return;
    readAt.current = opened;
    if (thread.unread) markRead();
  }, [disabled, thread.id, thread.lastMessageAt, thread.messageCount, thread.unread]);

  const settled = thread.state === "settled";

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Toggle
        variant="ghost"
        size="sm"
        pressed={chatOpen}
        disabled={chatDisabled}
        onPressedChange={onChatOpenChange}
      >
        <MessageSquareIcon />
        <T>Chat</T>
      </Toggle>
      <Button size="sm" variant="ghost" disabled={!canReply} onClick={() => onCompose("reply")}>
        <ReplyIcon />
        <T>Reply</T>
      </Button>
      {canReplyAll ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={!canReply}
          onClick={() => onCompose("replyAll")}
        >
          <ReplyAllIcon />
          <T>Reply all</T>
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" disabled={!canReply} onClick={() => onCompose("forward")}>
        <ForwardIcon />
        <T>Forward</T>
      </Button>
      {thread.state === "snoozed" ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => void act([thread.id], { type: "unsnooze" }, gt("Moved back to Active"))}
        >
          <AlarmClockOffIcon />
          <T>Wake now</T>
        </Button>
      ) : settled ? null : (
        <SnoozeMenu
          environmentId={environmentId}
          disabled={disabled}
          onSnooze={(until) =>
            void act([thread.id], { type: "snooze", until, onReply: true }, gt("Snoozed"))
          }
        />
      )}
      {settled ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => void act([thread.id], { type: "unsettle" }, gt("Moved back to Active"))}
        >
          <Undo2Icon />
          <T>Move back to Active</T>
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() =>
            void act(
              [thread.id],
              thread.suggestion
                ? { type: "approve", revisions: { [thread.id]: thread.suggestion.revision } }
                : { type: "settle" },
              gt("Settled"),
            )
          }
        >
          <CheckIcon />
          {thread.suggestion
            ? gt("Settle as {reason}", {
                reason: settleReasonLabel(thread.suggestion.reason, resolve),
              })
            : gt("Settle")}
        </Button>
      )}
      <Menu>
        <MenuTrigger
          disabled={disabled}
          render={
            <Button size="icon-sm" variant="ghost-muted" aria-label={gt("More mail actions")} />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {(thread.pinnedAt || !settled) && (
            <MenuItem
              onClick={() =>
                void act(
                  [thread.id],
                  { type: thread.pinnedAt ? "unpin" : "pin" },
                  thread.pinnedAt ? gt("Unpinned") : gt("Pinned"),
                )
              }
            >
              {thread.pinnedAt ? gt("Unpin") : gt("Pin")}
            </MenuItem>
          )}
          {!settled && thread.workingReason !== "waiting" && (
            <MenuItem
              onClick={() =>
                void act([thread.id], { type: "wait_for_reply" }, gt("Waiting for reply"))
              }
            >
              {gt("Wait for reply")}
            </MenuItem>
          )}
          {thread.state === "working" && (
            <MenuItem
              onClick={() =>
                void act([thread.id], { type: "unsettle" }, gt("Moved back to Active"))
              }
            >
              {gt("Move back to Active")}
            </MenuItem>
          )}
          <MenuItem
            onClick={() => void act([thread.id], { type: "mark_unread" }, gt("Marked as unread"))}
          >
            {gt("Mark as unread")}
          </MenuItem>
          <MenuItem
            onClick={() => void act([thread.id], { type: "never_show" }, gt("Sender muted"))}
          >
            {gt("Never show this sender")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            variant="destructive"
            onClick={async () => {
              const deleted = await act([thread.id], { type: "delete" }, gt("Moved to Trash"));
              if (deleted) void navigate({ to: "/mail" });
            }}
          >
            {gt("Delete")}
          </MenuItem>
        </MenuPopup>
      </Menu>
      {onToggleDetails === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={detailsOpen}
                onPressedChange={onToggleDetails}
                aria-label={gt("Toggle mail details")}
                variant="ghost"
                size="sm"
              />
            }
          >
            <SquareMenuIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            <T>Toggle mail details</T>
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}
