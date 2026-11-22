import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MailActionEntry,
  MailThreadId,
  MailSettleReason,
  MailThreadRow,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import {
  InboxIcon,
  ListFilterIcon,
  SearchIcon,
  SquarePenIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn, randomUUID } from "../../lib/utils";
import {
  mailEnvironment,
  useMailEnvironmentId,
  useMailSections,
  useMailStatus,
} from "../../state/mail";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarContent, SidebarGroup, SidebarInput } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { settleReasonLabel } from "./mailPresentation";
import { MailSidebarRow } from "./MailSidebarRow";
import { useMailActions } from "./useMailActions";
import { useMailIntentPrefetch } from "./useMailIntentPrefetch";
import { useMailRowMenu } from "./useMailRowMenu";

type SettledFilter = "all" | "ai" | MailSettleReason;
const SETTLED_FILTER_REASONS: ReadonlyArray<MailSettleReason> = [
  "fyi",
  "receipt",
  "noise",
  "replied",
  "done",
  "archived",
];
const SETTLED_PAGE = 30;
const SENT_PAGE = 30;
const TRASH_PAGE = 30;

export default function MailSidebar() {
  const environmentId = useMailEnvironmentId();
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      {environmentId === null ? (
        <SidebarContent className="min-h-full">
          <SidebarGroup className="flex-1">
            <p className="px-2.5 py-2 text-sm text-muted-foreground">
              <T>No connected server has Mail.</T>
            </p>
          </SidebarGroup>
        </SidebarContent>
      ) : (
        <MailSidebarBody environmentId={environmentId} />
      )}
      <SidebarChromeFooter />
    </>
  );
}

function MailSidebarBody({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const navigate = useNavigate();
  const sections = useMailSections(environmentId);
  const actions = useMailActions(environmentId);
  const prefetch = useMailIntentPrefetch(environmentId);
  const openRowMenu = useMailRowMenu(environmentId, actions);
  const routeMailThreadId = useParams({
    strict: false,
    select: (params) => ("mailThreadId" in params ? String(params.mailThreadId) : null),
  });
  const routeTarget = useThreadRouteTarget();
  const routeChatThreadId = routeTarget?.kind === "server" ? routeTarget.threadRef.threadId : null;
  const [query, setQuery] = useState("");
  const [serverSearch, setServerSearch] = useState(false);
  const debouncedQuery = useDebouncedValue(query.trim(), 200);
  const [workingOpen, setWorkingOpen] = useState(false);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [settledOpen, setSettledOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(true);
  const [sentOpen, setSentOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const newEmailShortcut = shortcutLabelForCommand(keybindings, "chat.new");

  const isActive = (thread: MailThreadRow) =>
    thread.id === routeMailThreadId ||
    (routeChatThreadId !== null && thread.chatThreadId === routeChatThreadId);
  const row = (thread: MailThreadRow) => (
    <MailSidebarRow
      key={thread.id}
      environmentId={environmentId}
      thread={thread}
      isActive={isActive(thread)}
      actions={actions}
      onIntent={prefetch}
      onContextMenu={openRowMenu}
    />
  );

  return (
    <SidebarContent
      className="min-h-full"
      fixedHeader={
        <SidebarGroup className="z-[1]">
          <div className="flex items-center gap-1">
            <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70 hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
              <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
              <SidebarInput
                nativeInput
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setServerSearch(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") setServerSearch(true);
                  if (event.key === "Escape") setQuery("");
                }}
                placeholder={gt("Search mail")}
                aria-label={gt("Search mail")}
                className="min-w-0 flex-1"
              />
              {query.length > 0 ? (
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label={gt("Clear mail search")}
                  onClick={() => setQuery("")}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : null}
            </div>
            <SidebarHeaderIconButton
              label={gt("New email")}
              tooltip={
                newEmailShortcut
                  ? gt("New email ({shortcut})", { shortcut: newEmailShortcut })
                  : gt("New email")
              }
              onClick={() => void navigate({ to: "/mail/new", search: { email: randomUUID() } })}
            >
              <SquarePenIcon />
            </SidebarHeaderIconButton>
            <SidebarHeaderIconButton
              label={gt("Mail home")}
              onClick={() => void navigate({ to: "/mail" })}
            >
              <InboxIcon />
            </SidebarHeaderIconButton>
          </div>
        </SidebarGroup>
      }
    >
      <SidebarGroup className="flex-1" role="presentation">
        {debouncedQuery.length > 0 ? (
          <MailSearchResults
            environmentId={environmentId}
            query={debouncedQuery}
            server={serverSearch}
            renderRow={row}
          />
        ) : sections === null ? (
          <div className="flex justify-center py-4">
            <Spinner className="size-4" />
          </div>
        ) : (
          <ul role="presentation" className="flex min-h-full flex-1 flex-col gap-px">
            {sections.pinned.map(row)}
            {sections.active.length === 0 && sections.pinned.length === 0 ? (
              <li className="list-none px-2.5 py-2 text-sm text-muted-foreground">
                <T>Nothing needs you.</T>
              </li>
            ) : null}
            {sections.active.map(row)}
            <MailShelf
              className="mt-auto"
              label={gt("Working", { $context: "sidebar section" })}
              count={sections.working.length}
              expanded={workingOpen}
              onToggle={() => setWorkingOpen((open) => !open)}
            >
              {sections.working.map(row)}
            </MailShelf>
            <MailShelf
              label={gt("Snoozed", { $context: "sidebar section" })}
              count={sections.snoozed.length}
              expanded={snoozedOpen}
              onToggle={() => setSnoozedOpen((open) => !open)}
            >
              {sections.snoozed.map(row)}
            </MailShelf>
            <MailShelf
              label={gt("Drafts", { $context: "sidebar section" })}
              count={sections.drafts.length}
              expanded={draftsOpen}
              onToggle={() => setDraftsOpen((open) => !open)}
            >
              {sections.drafts.map(row)}
            </MailShelf>
            <SettledShelf
              environmentId={environmentId}
              expanded={settledOpen}
              onToggle={() => setSettledOpen((open) => !open)}
              recent={sections.settled}
              renderRow={row}
            />
            <SentShelf
              environmentId={environmentId}
              expanded={sentOpen}
              onToggle={() => setSentOpen((open) => !open)}
              renderRow={(thread) => (
                <MailSidebarRow
                  key={thread.id}
                  environmentId={environmentId}
                  thread={thread}
                  isActive={isActive(thread)}
                  actions={actions}
                  timestamp={thread.lastOutgoingAt ?? thread.lastMessageAt}
                  onIntent={prefetch}
                  onContextMenu={openRowMenu}
                />
              )}
            />
            <TrashShelf
              environmentId={environmentId}
              expanded={trashOpen}
              onToggle={() => setTrashOpen((open) => !open)}
            />
          </ul>
        )}
      </SidebarGroup>
    </SidebarContent>
  );
}

function MailShelf(props: {
  label: string;
  /** Left out where a total would cost a query, such as Sent. */
  count?: number;
  expanded: boolean;
  onToggle: () => void;
  className?: string;
  accessory?: ReactNode;
  children: ReactNode;
}) {
  if (props.count === 0 && props.accessory === undefined) return null;
  return (
    <>
      <li className={cn("relative mx-0.5 flex h-8 list-none items-center", props.className)}>
        <CollapsibleSectionHeader
          onClick={props.onToggle}
          expanded={props.expanded}
          accessory={
            props.count === undefined ? undefined : (
              <span className="font-normal tabular-nums">{props.count}</span>
            )
          }
        >
          {props.label}
        </CollapsibleSectionHeader>
        {props.accessory}
      </li>
      {props.expanded ? props.children : null}
    </>
  );
}

function SettledShelf(props: {
  environmentId: EnvironmentId;
  expanded: boolean;
  onToggle: () => void;
  recent: ReadonlyArray<MailThreadRow>;
  renderRow: (thread: MailThreadRow) => ReactNode;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const [filter, setFilter] = useState<SettledFilter>("all");
  const [cursors, setCursors] = useState<Array<{ at: string; id: MailThreadId }>>([]);
  const before = cursors.at(-1);
  const status = useMailStatus(props.environmentId);
  const page = useEnvironmentQuery(
    props.expanded
      ? mailEnvironment.settled({
          environmentId: props.environmentId,
          input: {
            limit: SETTLED_PAGE,
            ...(before ? { before } : {}),
            ...(filter === "ai" ? { byAi: true } : filter === "all" ? {} : { reason: filter }),
          },
        })
      : null,
  );
  const threads =
    page.data?.threads ??
    (filter === "all" ? (before ? [] : props.recent.slice(0, SETTLED_PAGE)) : []);
  const filterLabel =
    filter === "all"
      ? gt("Settled", { $context: "sidebar section" })
      : filter === "ai"
        ? gt("Settled by AI")
        : gt("Settled: {reason}", { reason: settleReasonLabel(filter, resolve) });

  return (
    <MailShelf
      label={filterLabel}
      count={filter === "all" ? (status?.settledCount ?? props.recent.length) : threads.length}
      expanded={props.expanded}
      onToggle={props.onToggle}
      accessory={
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={gt("Filter settled mail")}
                className="ms-1 shrink-0"
              />
            }
          >
            <ListFilterIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuRadioGroup
              value={filter}
              onValueChange={(value: SettledFilter) => {
                setFilter(value);
                setCursors([]);
                if (!props.expanded) props.onToggle();
              }}
            >
              <MenuRadioItem value="all">
                <MenuRadioItemIndicator />
                <T>All settled</T>
              </MenuRadioItem>
              <MenuRadioItem value="ai">
                <MenuRadioItemIndicator />
                <T>Settled by AI</T>
              </MenuRadioItem>
              {SETTLED_FILTER_REASONS.map((reason) => (
                <MenuRadioItem key={reason} value={reason}>
                  <MenuRadioItemIndicator />
                  {settleReasonLabel(reason, resolve)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      }
    >
      {threads.map(props.renderRow)}
      {page.error && (
        <li role="alert" className="px-2 text-xs text-destructive-foreground">
          {page.error}
        </li>
      )}
      {(before || page.data?.hasMore) && (
        <li className="flex list-none gap-2 px-1">
          {before && (
            <Button size="xs" variant="ghost" onClick={() => setCursors(cursors.slice(0, -1))}>
              {gt("Previous")}
            </Button>
          )}
          {page.data?.hasMore && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                const last = threads.at(-1);
                if (last) setCursors([...cursors, { at: last.lastMessageAt, id: last.id }]);
              }}
            >
              {gt("Next")}
            </Button>
          )}
        </li>
      )}
    </MailShelf>
  );
}

function PageButtons(props: {
  hasPrevious: boolean;
  hasMore: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const gt = useGT();
  if (!props.hasPrevious && !props.hasMore) return null;
  return (
    <li className="flex list-none gap-2 px-1">
      {props.hasPrevious && (
        <Button size="xs" variant="ghost" onClick={props.onPrevious}>
          {gt("Previous")}
        </Button>
      )}
      {props.hasMore && (
        <Button size="xs" variant="ghost" onClick={props.onNext}>
          {gt("Next")}
        </Button>
      )}
    </li>
  );
}

function SentShelf(props: {
  environmentId: EnvironmentId;
  expanded: boolean;
  onToggle: () => void;
  renderRow: (thread: MailThreadRow) => ReactNode;
}) {
  const gt = useGT();
  const [cursors, setCursors] = useState<Array<{ at: string; id: MailThreadId }>>([]);
  const before = cursors.at(-1);
  const page = useEnvironmentQuery(
    props.expanded
      ? mailEnvironment.sent({
          environmentId: props.environmentId,
          input: { limit: SENT_PAGE, ...(before ? { before } : {}) },
        })
      : null,
  );
  const threads = page.data?.threads ?? [];
  return (
    <MailShelf
      label={gt("Sent", { $context: "sidebar section" })}
      expanded={props.expanded}
      onToggle={props.onToggle}
    >
      {threads.map(props.renderRow)}
      {page.data && threads.length === 0 ? (
        <li className="list-none px-2.5 py-1 text-xs text-muted-foreground">
          <T>No sent mail.</T>
        </li>
      ) : null}
      {page.error && (
        <li role="alert" className="px-2 text-xs text-destructive-foreground">
          {page.error}
        </li>
      )}
      <PageButtons
        hasPrevious={before !== undefined}
        hasMore={page.data?.hasMore ?? false}
        onPrevious={() => setCursors(cursors.slice(0, -1))}
        onNext={() => {
          const last = threads.at(-1);
          if (last?.lastOutgoingAt)
            setCursors([...cursors, { at: last.lastOutgoingAt, id: last.id }]);
        }}
      />
    </MailShelf>
  );
}

function TrashShelf(props: {
  environmentId: EnvironmentId;
  expanded: boolean;
  onToggle: () => void;
}) {
  const gt = useGT();
  const [cursors, setCursors] = useState<Array<number>>([]);
  const beforeId = cursors.at(-1);
  const page = useEnvironmentQuery(
    props.expanded
      ? mailEnvironment.trash({
          environmentId: props.environmentId,
          input: { limit: TRASH_PAGE, ...(beforeId === undefined ? {} : { beforeId }) },
        })
      : null,
  );
  const entries = page.data?.actions ?? [];
  return (
    <MailShelf
      label={gt("Trash", { $context: "sidebar section" })}
      expanded={props.expanded}
      onToggle={props.onToggle}
    >
      {entries.map((entry) => (
        <MailTrashRow
          key={entry.id}
          environmentId={props.environmentId}
          entry={entry}
          onRestored={page.refresh}
        />
      ))}
      {page.data && entries.length === 0 ? (
        <li className="list-none px-2.5 py-1 text-xs text-muted-foreground">
          <T>Nothing deleted in the last 30 days.</T>
        </li>
      ) : null}
      {page.error && (
        <li role="alert" className="px-2 text-xs text-destructive-foreground">
          {page.error}
        </li>
      )}
      <PageButtons
        hasPrevious={beforeId !== undefined}
        hasMore={page.data?.hasMore ?? false}
        onPrevious={() => setCursors(cursors.slice(0, -1))}
        onNext={() => {
          const last = entries.at(-1);
          if (last) setCursors([...cursors, last.id]);
        }}
      />
    </MailShelf>
  );
}

/** An email deleted here. It is gone from this list until Restore brings it back from Trash. */
function MailTrashRow(props: {
  environmentId: EnvironmentId;
  entry: MailActionEntry;
  onRestored: () => void;
}) {
  const gt = useGT();
  const { undo, disabled } = useMailActions(props.environmentId);
  const [restoring, setRestoring] = useState(false);
  const { entry } = props;
  return (
    <li className="group/sidebar-row flex list-none items-center gap-1.5 rounded-md px-(--sidebar-row-content-inset) py-1.5 text-sidebar-muted-foreground hover:bg-sidebar-row-hover">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-secondary-label">
          {entry.from ?? gt("Unknown sender")}
        </p>
        <p className="truncate text-sm">{entry.subject || gt("(No subject)")}</p>
      </div>
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled || restoring}
        aria-label={gt("Restore {subject}", { subject: entry.subject || gt("(No subject)") })}
        onClick={async () => {
          setRestoring(true);
          const restored = await undo([entry.id]);
          setRestoring(false);
          if (!restored) return;
          toastManager.add({ type: "success", title: gt("Moving back to Inbox") });
          props.onRestored();
        }}
      >
        <Undo2Icon />
        {gt("Restore")}
      </Button>
    </li>
  );
}

function MailSearchResults(props: {
  environmentId: EnvironmentId;
  query: string;
  server: boolean;
  renderRow: (thread: MailThreadRow) => ReactNode;
}) {
  const result = useEnvironmentQuery(
    mailEnvironment.search({
      environmentId: props.environmentId,
      input: { query: props.query, limit: 50, ...(props.server ? { server: true } : {}) },
    }),
  );
  if (result.data === null) {
    return result.error ? (
      <p className="px-2.5 py-2 text-sm text-destructive-foreground">{result.error}</p>
    ) : (
      <div className="flex justify-center py-4">
        <Spinner className="size-4" />
      </div>
    );
  }
  return (
    <ul role="presentation" className="flex flex-col gap-px">
      {result.data.threads.length === 0 ? (
        <li className="list-none px-2.5 py-2 text-sm text-muted-foreground">
          {props.server ? (
            <T>No mail matches.</T>
          ) : (
            <T>No mail matches. Press Enter to also search the server.</T>
          )}
        </li>
      ) : null}
      {result.data.threads.map(props.renderRow)}
    </ul>
  );
}
