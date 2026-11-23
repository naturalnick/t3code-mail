import type { EnvironmentId, MailAccount, MailLabelScope, MailThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CheckIcon, FolderIcon, ListFilterIcon, TagIcon } from "lucide-react";
import { useState } from "react";

import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { useMailActions } from "./useMailActions";

type LabelItem = MailLabelScope & { account: string };

function LabelPicker(props: {
  items: LabelItem[];
  title: string;
  selected: (item: LabelItem) => boolean;
  onPick: (item: LabelItem) => void;
  disabled?: boolean;
  filter?: { active: boolean; clear: () => void };
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  return (
    <Combobox<LabelItem>
      open={open}
      onOpenChange={setOpen}
      items={props.items}
      value={null}
      autoHighlight
      itemToStringLabel={(item) => [item.name, item.account].join(" ")}
      onValueChange={(item) => {
        if (item) props.onPick(item);
      }}
    >
      <ComboboxTrigger
        disabled={props.disabled}
        render={
          props.filter ? (
            <SidebarHeaderIconButton label={props.title} data-active={props.filter.active} />
          ) : (
            <Button size="sm" variant="ghost" className="min-w-0" />
          )
        }
      >
        {props.filter ? (
          <ListFilterIcon className={props.filter.active ? "text-primary" : undefined} />
        ) : (
          <>
            <TagIcon className="size-3.5 shrink-0" />
            <span className="truncate">{props.title}</span>
          </>
        )}
      </ComboboxTrigger>
      <ComboboxPopup className="w-[min(18rem,var(--available-width))]">
        <ComboboxSearchInput aria-label={gt("Search labels")} placeholder={gt("Search labels")} />
        <ComboboxEmpty>{gt("No matching labels")}</ComboboxEmpty>
        <ComboboxList>
          {(item: LabelItem) => (
            <ComboboxItem
              key={JSON.stringify([item.accountId, item.kind, item.name])}
              aria-selected={props.selected(item)}
              value={item}
            >
              {item.kind === "folder" ? <FolderIcon /> : <TagIcon />}
              <div className="min-w-0 flex-1">
                <div className="break-words">{item.name}</div>
                {item.account && (
                  <div className="truncate text-xs text-muted-foreground">{item.account}</div>
                )}
              </div>
              {props.selected(item) && <CheckIcon aria-label={gt("Selected")} />}
            </ComboboxItem>
          )}
        </ComboboxList>
        {props.filter?.active && (
          <div className="border-t p-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                props.filter?.clear();
                setOpen(false);
              }}
            >
              {gt("Clear label filter")}
            </Button>
          </div>
        )}
      </ComboboxPopup>
    </Combobox>
  );
}

export function MailLabelFilter(props: {
  accounts: readonly Pick<MailAccount, "id" | "email" | "labels" | "folders">[];
  scope: MailLabelScope | null;
  onPick: (scope: MailLabelScope | null) => void;
}) {
  const gt = useGT();
  const items = props.accounts.flatMap((account) => {
    const item = (name: string, kind: MailLabelScope["kind"]) => ({
      name,
      kind,
      accountId: account.id,
      account: props.accounts.length > 1 ? account.email : "",
    });
    return [
      ...(account.labels ?? []).map((name) => item(name, "label")),
      ...(account.folders ?? []).map((name) => item(name, "folder")),
    ];
  });
  if (!items.length && !props.accounts.some((account) => account.labels !== undefined)) return null;
  return (
    <LabelPicker
      items={items}
      title={props.scope ? `${gt("Filter by label")} · ${props.scope.name}` : gt("Filter by label")}
      filter={{ active: props.scope !== null, clear: () => props.onPick(null) }}
      selected={(item) =>
        item.accountId === props.scope?.accountId &&
        item.name === props.scope.name &&
        item.kind === props.scope.kind
      }
      onPick={({ accountId, name, kind }) => props.onPick({ accountId, name, kind })}
    />
  );
}

export function MailThreadLabels({
  environmentId,
  account,
  threadId,
  labels,
  refresh,
}: {
  environmentId: EnvironmentId;
  account: MailAccount;
  threadId: MailThreadId;
  labels: readonly string[];
  refresh: () => void;
}) {
  const gt = useGT();
  const actions = useMailActions(environmentId);
  const [pending, setPending] = useState(false);
  const items = (account.labels ?? []).map((name) => ({
    name,
    kind: "label" as const,
    accountId: account.id,
    account: "",
  }));
  if (!labels.length && !items.length) return null;
  return (
    <div className="min-w-0 space-y-1 px-3 py-2">
      <LabelPicker
        title={gt("Labels")}
        items={items}
        disabled={pending || actions.disabled || !items.length}
        selected={(item) => labels.includes(item.name)}
        onPick={async (item) => {
          setPending(true);
          await actions
            .act([threadId], {
              type: "label",
              name: item.name,
              apply: !labels.includes(item.name),
            })
            .finally(() => setPending(false));
          refresh();
        }}
      />
      {labels.length > 0 && (
        <ul className="flex flex-wrap gap-x-2 gap-y-1 px-2 text-xs text-muted-foreground">
          {labels.map((name) => (
            <li className="break-all" key={name}>
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
