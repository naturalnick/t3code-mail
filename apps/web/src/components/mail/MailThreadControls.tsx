import type { EnvironmentId, MailThreadRow } from "@t3tools/contracts";
import { Link, useRouter } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { EllipsisIcon, MessageSquareIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef } from "react";

import { mailEnvironment } from "../../state/mail";
import { useMailCommand } from "../settings/MailSettings.commands";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { settleReasonLabel } from "./mailPresentation";
import { useMailActions } from "./useMailActions";

export function MailThreadControls({
  environmentId,
  thread,
}: {
  environmentId: EnvironmentId;
  thread: MailThreadRow;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const router = useRouter();
  const { act, disabled } = useMailActions(environmentId);
  const openSession = useMailCommand(
    environmentId,
    mailEnvironment.openSession,
    gt("Could not open mail chat"),
  );
  const markRead = useEffectEvent(() => void act([thread.id], { type: "mark_read" }));
  const readAt = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Opening unread mail acknowledges it on the server.
  useEffect(() => {
    const opened = `${thread.id}/${thread.lastMessageAt}/${thread.messageCount}`;
    if (disabled || readAt.current === opened) return;
    readAt.current = opened;
    if (thread.unread) markRead();
  }, [disabled, thread.id, thread.lastMessageAt, thread.messageCount, thread.unread]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {thread.chatThreadId && openSession.disabled && !openSession.pending ? (
        <Button
          size="sm"
          variant="outline"
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: thread.chatThreadId }}
            />
          }
        >
          <MessageSquareIcon />
          {gt("Open chat")}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={openSession.disabled}
          onClick={async () => {
            const location = router.state.location;
            const result = await openSession.run({ threadId: thread.id });
            if (result && router.state.location === location) {
              await router.navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: result.value.threadId },
              });
            }
          }}
        >
          <MessageSquareIcon />
          {thread.chatThreadId ? gt("Open chat") : gt("Start mail chat")}
        </Button>
      )}
      {thread.state === "settled" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void act([thread.id], { type: "unsettle" }, gt("Moved back to Active"))}
        >
          {gt("Move back to Active")}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
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
          {thread.suggestion
            ? gt("Settle as {reason}", {
                reason: settleReasonLabel(thread.suggestion.reason, resolve),
              })
            : gt("Settle")}
        </Button>
      )}
      {thread.suggestion && (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void act([thread.id], { type: "keep" }, gt("Kept in Active"))}
        >
          {gt("Keep in Active")}
        </Button>
      )}
      {thread.state === "snoozed" && (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void act([thread.id], { type: "unsnooze" }, gt("Moved back to Active"))}
        >
          {gt("Wake now")}
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
          {(thread.pinnedAt || thread.state !== "settled") && (
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
          {thread.state !== "settled" && (
            <>
              <MenuItem
                onClick={() =>
                  void act(
                    [thread.id],
                    {
                      type: "snooze",
                      until: new Date(Date.now() + 86_400_000).toISOString(),
                      onReply: true,
                    },
                    gt("Snoozed"),
                  )
                }
              >
                {gt("Snooze for one day or until reply")}
              </MenuItem>
              <MenuItem
                onClick={() =>
                  void act(
                    [thread.id],
                    { type: "snooze", until: null, onReply: true },
                    gt("Snoozed"),
                  )
                }
              >
                {gt("Snooze until reply")}
              </MenuItem>
              {thread.workingReason !== "waiting" && (
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
            </>
          )}
          <MenuItem
            onClick={() => void act([thread.id], { type: "never_show" }, gt("Sender muted"))}
          >
            {gt("Never show this sender")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
