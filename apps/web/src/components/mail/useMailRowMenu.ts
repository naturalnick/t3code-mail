import type { ContextMenuItem, EnvironmentId, MailThreadRow } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import type { MouseEvent } from "react";

import { contextMenuSourceOf } from "../../contextMenuSource";
import { useClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { readLocalApi } from "../../localApi";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { pickSnoozePreset, resolveSnoozePresets } from "../Sidebar.snooze";
import { settleReasonLabel } from "./mailPresentation";
import type { useMailActions } from "./useMailActions";

/** The right-click menu for an email row: everything the email's own toolbar offers. */
export function useMailRowMenu(
  environmentId: EnvironmentId,
  actions: ReturnType<typeof useMailActions>,
) {
  const gt = useGT();
  const resolve = useMessages();
  const navigate = useNavigate();
  const openMailThreadId = useParams({
    strict: false,
    select: (params) => ("mailThreadId" in params ? String(params.mailThreadId) : null),
  });
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);

  return useStableCallback(async (thread: MailThreadRow, event: MouseEvent) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api || actions.disabled) return;
    const settled = thread.state === "settled";
    const presets = resolveSnoozePresets(new Date(), timestampFormat, environmentId, resolve);
    const items: Array<ContextMenuItem> = [
      { id: "reply", label: gt("Reply") },
      { id: "forward", label: gt("Forward") },
      thread.unread
        ? { id: "mark_read", label: gt("Mark as read"), separatorBefore: true }
        : { id: "mark_unread", label: gt("Mark as unread"), separatorBefore: true },
      { id: thread.pinnedAt ? "unpin" : "pin", label: thread.pinnedAt ? gt("Unpin") : gt("Pin") },
      ...(thread.state === "snoozed"
        ? [{ id: "unsnooze", label: gt("Wake now") }]
        : settled
          ? []
          : [
              {
                id: "snooze",
                label: gt("Snooze"),
                children: [
                  ...presets.map((preset) => ({
                    id: `snooze:${preset.id}`,
                    label: preset.label,
                    detail: preset.whenLabel,
                  })),
                  { id: "snooze:reply", label: gt("Until reply"), separatorBefore: true },
                  { id: "snooze:custom", label: gt("Custom…") },
                ],
              },
            ]),
      settled
        ? { id: "unsettle", label: gt("Move back to Active") }
        : {
            id: "settle",
            label: thread.suggestion
              ? gt("Settle as {reason}", {
                  reason: settleReasonLabel(thread.suggestion.reason, resolve),
                })
              : gt("Settle"),
          },
      ...(settled || thread.workingReason === "waiting"
        ? []
        : [{ id: "wait_for_reply", label: gt("Wait for reply") }]),
      { id: "never_show", label: gt("Never show this sender"), separatorBefore: true },
      { id: "delete", label: gt("Delete"), destructive: true },
    ];
    const clicked = await api.contextMenu
      .show(items, { x: event.clientX, y: event.clientY }, contextMenuSourceOf(event))
      .catch(() => null);
    if (clicked === null) return;
    const ids = [thread.id];
    const snooze = (until: string | null) =>
      void actions.act(ids, { type: "snooze", until, onReply: true }, gt("Snoozed"));
    switch (clicked) {
      case "reply":
      case "forward":
        void navigate({
          to: "/mail/$mailThreadId",
          params: { mailThreadId: thread.id },
          search: { compose: clicked },
        });
        return;
      case "mark_read":
        void actions.act(ids, { type: "mark_read" });
        return;
      case "mark_unread":
        void actions.act(ids, { type: "mark_unread" }, gt("Marked as unread"));
        return;
      case "pin":
      case "unpin":
        void actions.act(ids, { type: clicked }, clicked === "pin" ? gt("Pinned") : gt("Unpinned"));
        return;
      case "unsnooze":
      case "unsettle":
        void actions.act(ids, { type: clicked }, gt("Moved back to Active"));
        return;
      case "settle":
        void actions.act(
          ids,
          thread.suggestion
            ? { type: "approve", revisions: { [thread.id]: thread.suggestion.revision } }
            : { type: "settle" },
          gt("Settled"),
        );
        return;
      case "wait_for_reply":
        void actions.act(ids, { type: "wait_for_reply" }, gt("Waiting for reply"));
        return;
      case "never_show":
        void actions.act(ids, { type: "never_show" }, gt("Sender muted"));
        return;
      case "delete": {
        const deleted = await actions.act(ids, { type: "delete" }, gt("Moved to Trash"));
        if (deleted && openMailThreadId === thread.id) void navigate({ to: "/mail" });
        return;
      }
      case "snooze:reply":
        snooze(null);
        return;
      case "snooze:custom": {
        const choice = await requestCustomSnooze();
        if (choice) snooze(choice.snoozedUntil);
        return;
      }
    }
    if (clicked.startsWith("snooze:")) {
      const id = clicked.slice("snooze:".length);
      const picked = pickSnoozePreset(presets, id, timestampFormat, environmentId, resolve);
      if (picked) snooze(picked.snoozedUntil);
    }
  });
}
