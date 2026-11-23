import type {
  MailAccount,
  MailThreadAction,
  MailThreadId,
  MailThreadRow,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ChevronDownIcon, XIcon } from "lucide-react";

import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";

export function MailInboxSelection(props: {
  rows: readonly MailThreadRow[];
  selected: ReadonlySet<MailThreadId>;
  accounts: readonly MailAccount[];
  busy: boolean;
  disabled: boolean;
  onSelectAll: (ids: Set<MailThreadId>) => void;
  onClose: () => void;
  onAction: (ids: MailThreadId[], action: MailThreadAction, done?: string) => void;
}) {
  const gt = useGT();
  const selectedRows = props.rows.filter((row) => props.selected.has(row.id));
  const ids = selectedRows.map((row) => row.id);
  const all = ids.length > 0 && ids.length === props.rows.length;
  const accounts = new Set(selectedRows.map((row) => row.accountId));
  const catalogs = Array.from(
    accounts,
    (id) => props.accounts.find((a) => a.id === id)?.labels ?? [],
  );
  const others = catalogs.slice(1).map((catalog) => new Set(catalog));
  const labels = catalogs[0]?.filter((name) => others.every((catalog) => catalog.has(name))) ?? [];
  const act = (action: MailThreadAction, done?: string) => props.onAction(ids, action, done);
  return (
    <div className="flex h-8 w-full items-center gap-1 px-2">
      <Checkbox
        aria-label={gt("Select all")}
        checked={all}
        indeterminate={!all && ids.length > 0}
        disabled={props.busy || props.rows.length === 0}
        onCheckedChange={() =>
          props.onSelectAll(new Set(all ? [] : props.rows.map((row) => row.id)))
        }
      />
      <Menu>
        <MenuTrigger
          disabled={props.busy || props.disabled || !ids.length}
          render={<Button size="sm" variant="ghost" />}
        >
          {gt("{count} selected", { count: ids.length })}
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuItem onClick={() => act({ type: "mark_read" }, gt("Marked as read"))}>
            <T>Mark as read</T>
          </MenuItem>
          <MenuItem onClick={() => act({ type: "mark_unread" }, gt("Marked as unread"))}>
            <T>Mark as unread</T>
          </MenuItem>
          {labels.length > 0 &&
            [true, false].map((apply) => (
              <MenuSub key={String(apply)}>
                <MenuSubTrigger>{apply ? gt("Apply label") : gt("Remove label")}</MenuSubTrigger>
                <MenuSubPopup>
                  {labels.map((name) => (
                    <MenuItem key={name} onClick={() => act({ type: "label", name, apply })}>
                      {name}
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            ))}
          <MenuSeparator />
          <MenuItem
            variant="destructive"
            onClick={() => act({ type: "delete" }, gt("Moved to Trash"))}
          >
            <T>Delete</T>
          </MenuItem>
        </MenuPopup>
      </Menu>
      <div className="ms-auto">
        <SidebarHeaderIconButton
          label={gt("Cancel selection")}
          disabled={props.busy}
          onClick={props.onClose}
        >
          <XIcon />
        </SidebarHeaderIconButton>
      </div>
    </div>
  );
}
