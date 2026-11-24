import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MailActionEntry,
  MailLabelScope,
  MailListLabeledInput,
  MailThreadAction,
  MailThreadId,
  MailThreadRow,
} from "@t3tools/contracts";
import { MAIL_ACTION_BATCH_SIZE } from "@t3tools/contracts";
import { useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  ChevronDownIcon,
  InboxIcon,
  ListFilterIcon,
  SearchIcon,
  SquarePenIcon,
  ListChecksIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { shortcutLabelForCommand } from "../../keybindings";
import { observeResize } from "../../lib/observeResize";
import { randomUUID } from "../../lib/utils";
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
import { MailInboxSelection } from "./MailInboxSelection";
import { MailLabelFilter } from "./MailLabels";
import { MailSidebarRow } from "./MailSidebarRow";
import { useMailActions } from "./useMailActions";
import { useMailIntentPrefetch } from "./useMailIntentPrefetch";
import { useMailRowMenu } from "./useMailRowMenu";

const mailboxes = [
  "inbox",
  "working",
  "snoozed",
  "drafts",
  "settled",
  "sent",
  "spam",
  "trash",
] as const;
type Mailbox = (typeof mailboxes)[number];
/** Lists of what was removed here, not thread lists a label can filter. */
type RemovedMailbox = "spam" | "trash";
const isRemoved = (mailbox: Mailbox | "all"): mailbox is RemovedMailbox =>
  mailbox === "spam" || mailbox === "trash";
type SettledFilter = "all" | "rule" | "user";
const SETTLED_PAGE = 30;
const THREAD_PAGE = 30;
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
        <MailSidebarBody key={environmentId} environmentId={environmentId} />
      )}
      <SidebarChromeFooter />
    </>
  );
}

function MailSidebarBody({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const navigate = useNavigate();
  const router = useRouter();
  const sections = useMailSections(environmentId);
  const actions = useMailActions(environmentId);
  const prefetch = useMailIntentPrefetch(environmentId);
  const status = useMailStatus(environmentId);
  const supportsSpam = status?.capabilities?.spam === true;
  const openRowMenu = useMailRowMenu(environmentId, actions, supportsSpam);
  const routeMailThreadId = useParams({
    strict: false,
    select: (params) => ("mailThreadId" in params ? String(params.mailThreadId) : null),
  });
  const routeTarget = useThreadRouteTarget();
  const routeChatThreadId = routeTarget?.kind === "server" ? routeTarget.threadRef.threadId : null;
  const [query, setQuery] = useState("");
  const [serverSearch, setServerSearch] = useState(false);
  const debouncedQuery = useDebouncedValue(query.trim(), 200);
  const [mailbox, setMailbox] = useState<Mailbox>("inbox");
  const [filteredMailbox, setFilteredMailbox] = useState<Exclude<Mailbox, RemovedMailbox> | "all">(
    "all",
  );
  const [labelScope, setLabelScope] = useState<MailLabelScope | null>(null);
  const searching = query.trim() !== "" && debouncedQuery !== "";
  const view = labelScope ? "label" : searching ? "search" : mailbox;
  const [selection, setSelection] = useState<Set<MailThreadId> | null>(null);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const selecting = selection !== null && view === "inbox";
  const toggleSelection = (id: MailThreadId) =>
    setSelection((current) => {
      if (!current) return null;
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const applySelection = async (ids: MailThreadId[], action: MailThreadAction, done?: string) => {
    if (selectionBusy || actions.disabled) return;
    const undoIds: number[] = [];
    const applyBatches = async () => {
      for (let offset = 0; offset < ids.length; offset += MAIL_ACTION_BATCH_SIZE) {
        const batch = ids.slice(offset, offset + MAIL_ACTION_BATCH_SIZE);
        const result = await actions.act(batch, action);
        if (result === null) return;
        undoIds.push(...result);
        const completed = new Set(batch);
        if (offset + batch.length < ids.length) {
          setSelection(
            (current) => current && new Set([...current].filter((id) => !completed.has(id))),
          );
        }
        if (
          action.type === "delete" &&
          router.state.matches.some(
            ({ params }) =>
              "mailThreadId" in params && batch.some((id) => id === params.mailThreadId),
          )
        ) {
          void navigate({ to: "/mail" });
        }
      }
      setSelection(null);
    };
    setSelectionBusy(true);
    await applyBatches().finally(() => {
      if (done !== undefined) actions.showUndo(undoIds, done);
      setSelectionBusy(false);
    });
  };
  const content = useRef<HTMLDivElement>(null);
  const inboxScroll = useRef(0);
  const mailboxLabels = {
    inbox: gt("Inbox"),
    working: gt("Working", { $context: "sidebar section" }),
    snoozed: gt("Snoozed", { $context: "sidebar section" }),
    drafts: gt("Drafts", { $context: "sidebar section" }),
    settled: gt("Settled", { $context: "sidebar section" }),
    sent: gt("Sent", { $context: "sidebar section" }),
    spam: gt("Spam", { $context: "sidebar section" }),
    trash: gt("Trash", { $context: "sidebar section" }),
  };
  const inboxUnread =
    sections === null
      ? 0
      : sections.pinned.filter((t) => t.unread).length +
        sections.active.filter((t) => t.unread).length;
  const unreadBadge = (count: number) =>
    count > 0 ? (
      <Badge size="sm">
        <span aria-hidden>{count}</span>
        <span className="sr-only">{gt("{count} unread", { count })}</span>
      </Badge>
    ) : null;
  const counts: Partial<Record<Mailbox, number | undefined>> = {
    inbox: sections ? sections.pinned.length + sections.active.length : undefined,
    working: sections?.working.length,
    snoozed: sections?.snoozed.length,
    drafts: sections?.drafts.length,
    settled: status?.settledCount ?? sections?.settled.length,
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restore the scroll viewport after switching lists and track the inbox position.
  useLayoutEffect(() => {
    const viewport = content.current?.closest<HTMLElement>("[data-slot=scroll-area-viewport]");
    if (!viewport) return;
    if (labelScope || view !== "inbox") {
      viewport.scrollTop = 0;
      return;
    }
    const saved = inboxScroll.current;
    viewport.scrollTop = saved;
    // Offscreen rows initially occupy estimated heights. Restore again after the browser lays them out.
    const stopObserving =
      viewport.scrollTop < saved && content.current
        ? observeResize(content.current, () => {
            viewport.scrollTop = saved;
            stopObserving?.();
          })
        : undefined;
    const remember = () => {
      inboxScroll.current = viewport.scrollTop;
    };
    viewport.addEventListener("scroll", remember);
    return () => {
      stopObserving?.();
      viewport.removeEventListener("scroll", remember);
    };
  }, [view, labelScope]);

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
      readerOpen={thread.id === routeMailThreadId}
      actions={actions}
      timestamp={
        (view === "sent" || (labelScope && filteredMailbox === "sent")) && thread.lastOutgoingAt
          ? thread.lastOutgoingAt
          : thread.lastMessageAt
      }
      selected={selecting ? selection.has(thread.id) : undefined}
      selectionBusy={selectionBusy}
      onToggleSelection={toggleSelection}
      onIntent={selecting ? undefined : prefetch}
      onContextMenu={selecting ? undefined : openRowMenu}
    />
  );

  return (
    <SidebarContent
      ref={content}
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
                  setSelection(null);
                  setQuery(event.currentTarget.value);
                  setServerSearch(false);
                }}
                onKeyDown={(event) => {
                  if (!labelScope && event.key === "Enter") setServerSearch(true);
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
            <MailLabelFilter
              accounts={status?.accounts ?? []}
              scope={labelScope}
              onPick={(scope) => {
                setSelection(null);
                setLabelScope(scope);
                if (scope?.kind === "folder") setFilteredMailbox("all");
                else if (scope && !labelScope)
                  setFilteredMailbox(isRemoved(mailbox) ? "all" : mailbox);
              }}
            />
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
          <div className="mt-1 flex items-center">
            {selecting && sections ? (
              <MailInboxSelection
                rows={[...sections.pinned, ...sections.active]}
                selected={selection}
                accounts={status?.accounts ?? []}
                busy={selectionBusy}
                disabled={actions.disabled}
                onSelectAll={setSelection}
                onClose={() => setSelection(null)}
                onAction={(ids, action, done) => void applySelection(ids, action, done)}
              />
            ) : (
              <>
                <Menu>
                  <MenuTrigger render={<Button variant="ghost" size="sm" />}>
                    {labelScope
                      ? filteredMailbox === "all"
                        ? gt("All mail")
                        : mailboxLabels[filteredMailbox]
                      : searching
                        ? gt("Search results")
                        : mailboxLabels[mailbox]}
                    {!labelScope && !searching && mailbox === "inbox" && unreadBadge(inboxUnread)}
                    <ChevronDownIcon className="size-3.5 text-muted-foreground" />
                  </MenuTrigger>
                  <MenuPopup align="start">
                    <MenuRadioGroup
                      value={labelScope ? filteredMailbox : view}
                      onValueChange={(next: Mailbox | "all") => {
                        if (labelScope && !isRemoved(next)) {
                          setFilteredMailbox(next);
                          if (next !== "all") setMailbox(next);
                          return;
                        }
                        if (next === "all") return;
                        setQuery("");
                        setServerSearch(false);
                        setLabelScope(null);
                        setMailbox(next);
                      }}
                    >
                      {labelScope && (
                        <MenuRadioItem value="all" closeOnClick>
                          <MenuRadioItemIndicator />
                          {gt("All mail")}
                        </MenuRadioItem>
                      )}
                      {mailboxes
                        .filter((item) => item !== "spam" || supportsSpam)
                        .map((item) => (
                          <MenuRadioItem key={item} value={item} closeOnClick>
                            <span className="grid grid-cols-[0.875rem_1fr_auto] items-center gap-x-2">
                              <span>
                                <MenuRadioItemIndicator />
                              </span>
                              <span>{mailboxLabels[item]}</span>
                              {!labelScope && counts[item] ? (
                                <span className="flex items-center justify-end gap-1.5 text-xs tabular-nums text-muted-foreground">
                                  {item === "inbox" && unreadBadge(inboxUnread)}
                                  {counts[item]}
                                </span>
                              ) : null}
                            </span>
                          </MenuRadioItem>
                        ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>
                {view === "inbox" &&
                  sections &&
                  sections.pinned.length + sections.active.length > 0 &&
                  !actions.disabled && (
                    <SidebarHeaderIconButton
                      className="ms-auto"
                      label={gt("Select emails")}
                      disabled={selectionBusy}
                      onClick={() => setSelection(new Set())}
                    >
                      <ListChecksIcon />
                    </SidebarHeaderIconButton>
                  )}
              </>
            )}
          </div>
        </SidebarGroup>
      }
    >
      <SidebarGroup className="flex-1" role="presentation">
        {labelScope ? (
          <ul role="presentation" className="flex flex-col gap-px">
            <PagedThreads
              key={JSON.stringify([labelScope, filteredMailbox, debouncedQuery])}
              active
              environmentId={environmentId}
              renderRow={row}
              filter={{
                scope: labelScope,
                ...(filteredMailbox === "all" ? {} : { mailbox: filteredMailbox }),
                ...(debouncedQuery ? { query: debouncedQuery } : {}),
              }}
            />
          </ul>
        ) : searching ? (
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
        ) : null}
        {sections && (
          <ul
            hidden={searching || labelScope !== null}
            role="presentation"
            className="flex min-h-full flex-1 flex-col gap-px [&[hidden]]:hidden"
          >
            {view === "inbox" && (
              <>
                {sections.pinned.map(row)}
                {sections.active.map(row)}
                {sections.active.length === 0 && sections.pinned.length === 0 && (
                  <li className="px-2.5 py-2 text-sm text-muted-foreground">
                    <T>Nothing needs you.</T>
                  </li>
                )}
              </>
            )}
            {(view === "working" || view === "snoozed" || view === "drafts") &&
              (sections[view].length > 0 ? sections[view].map(row) : <EmptyMailbox />)}
            <SettledList
              active={view === "settled"}
              environmentId={environmentId}
              recent={sections.settled}
              renderRow={row}
            />
            <PagedThreads active={view === "sent"} environmentId={environmentId} renderRow={row} />
            <TrashList
              key={view}
              kind={view === "spam" ? "spam" : "delete"}
              active={view === "trash" || view === "spam"}
              environmentId={environmentId}
            />
          </ul>
        )}
      </SidebarGroup>
    </SidebarContent>
  );
}

function EmptyMailbox({ children }: { children?: ReactNode }) {
  return (
    <li className="px-2.5 py-2 text-sm text-muted-foreground">
      {children ?? <T>This mailbox is empty.</T>}
    </li>
  );
}

function SettledList(props: {
  active: boolean;
  environmentId: EnvironmentId;
  recent: ReadonlyArray<MailThreadRow>;
  renderRow: (thread: MailThreadRow) => ReactNode;
}) {
  const gt = useGT();
  const [filter, setFilter] = useState<SettledFilter>("all");
  const [cursors, setCursors] = useState<Array<{ at: string; id: MailThreadId }>>([]);
  const before = cursors.at(-1);
  const page = useEnvironmentQuery(
    props.active
      ? mailEnvironment.settled({
          environmentId: props.environmentId,
          input: {
            limit: SETTLED_PAGE,
            ...(before ? { before } : {}),
            ...(filter === "all" ? {} : { by: filter }),
          },
        })
      : null,
  );
  if (!props.active) return null;
  const threads =
    page.data?.threads ??
    (filter === "all" ? (before ? [] : props.recent.slice(0, SETTLED_PAGE)) : []);
  const filterLabel =
    filter === "all"
      ? gt("All settled")
      : filter === "rule"
        ? gt("Settled by your rules")
        : gt("Settled by you");

  return (
    <>
      <li>
        <Menu>
          <MenuTrigger
            render={<Button size="xs" variant="ghost-muted" title={gt("Filter settled mail")} />}
          >
            <ListFilterIcon className="size-3.5" />
            {filterLabel}
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuRadioGroup
              value={filter}
              onValueChange={(value: SettledFilter) => {
                setFilter(value);
                setCursors([]);
              }}
            >
              <MenuRadioItem closeOnClick value="all">
                <span className="flex items-center gap-2">
                  <MenuRadioItemIndicator />
                  <T>All settled</T>
                </span>
              </MenuRadioItem>
              <MenuRadioItem closeOnClick value="rule">
                <span className="flex items-center gap-2">
                  <MenuRadioItemIndicator />
                  <T>Settled by your rules</T>
                </span>
              </MenuRadioItem>
              <MenuRadioItem closeOnClick value="user">
                <span className="flex items-center gap-2">
                  <MenuRadioItemIndicator />
                  <T>Settled by you</T>
                </span>
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      </li>
      {page.data && threads.length === 0 && <EmptyMailbox />}
      {threads.map(props.renderRow)}
      {!page.data && !page.error && threads.length === 0 && (
        <li className="flex justify-center py-4">
          <Spinner className="size-4" />
        </li>
      )}
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
          if (last) setCursors([...cursors, { at: last.lastMessageAt, id: last.id }]);
        }}
      />
    </>
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

function PagedThreads(props: {
  active: boolean;
  filter?: MailListLabeledInput;
  environmentId: EnvironmentId;
  renderRow: (thread: MailThreadRow) => ReactNode;
}) {
  const [cursors, setCursors] = useState<Array<{ at: string; id: MailThreadId }>>([]);
  const before = cursors.at(-1);
  const pageInput = { limit: THREAD_PAGE, ...(before ? { before } : {}) };
  const page = useEnvironmentQuery(
    !props.active
      ? null
      : props.filter
        ? mailEnvironment.labeled({
            environmentId: props.environmentId,
            input: { ...props.filter, ...pageInput },
          })
        : mailEnvironment.sent({ environmentId: props.environmentId, input: pageInput }),
  );
  if (!props.active) return null;
  const threads = page.data?.threads ?? [];
  return (
    <>
      {threads.map(props.renderRow)}
      {page.data && threads.length === 0 ? (
        <EmptyMailbox>{props.filter ? <T>No mail matches.</T> : <T>No sent mail.</T>}</EmptyMailbox>
      ) : null}
      {!page.data && !page.error && (
        <li className="flex justify-center py-4">
          <Spinner className="size-4" />
        </li>
      )}
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
          const at =
            props.filter && props.filter.mailbox !== "sent"
              ? last?.lastMessageAt
              : last?.lastOutgoingAt;
          if (last && at) setCursors([...cursors, { at, id: last.id }]);
        }}
      />
    </>
  );
}

function TrashList(props: {
  active: boolean;
  kind: "delete" | "spam";
  environmentId: EnvironmentId;
}) {
  const [cursors, setCursors] = useState<Array<number>>([]);
  const beforeId = cursors.at(-1);
  const page = useEnvironmentQuery(
    props.active
      ? mailEnvironment.trash({
          environmentId: props.environmentId,
          input: {
            limit: TRASH_PAGE,
            ...(props.kind === "spam" ? { kind: "spam" as const } : {}),
            ...(beforeId === undefined ? {} : { beforeId }),
          },
        })
      : null,
  );
  if (!props.active) return null;
  const entries = (page.data?.actions ?? []).filter((entry) => entry.kind === props.kind);
  return (
    <>
      {entries.map((entry) => (
        <MailTrashRow
          key={entry.id}
          environmentId={props.environmentId}
          entry={entry}
          onRestored={page.refresh}
        />
      ))}
      {page.data && entries.length === 0 ? (
        <EmptyMailbox>
          {props.kind === "spam" ? (
            <T>Nothing marked as spam in the last 30 days.</T>
          ) : (
            <T>Nothing deleted in the last 30 days.</T>
          )}
        </EmptyMailbox>
      ) : null}
      {!page.data && !page.error && (
        <li className="flex justify-center py-4">
          <Spinner className="size-4" />
        </li>
      )}
      {page.error && (
        <li role="alert" className="px-2 text-xs text-destructive-foreground">
          {page.error}
        </li>
      )}
      <PageButtons
        hasPrevious={beforeId !== undefined}
        hasMore={entries.length > 0 && (page.data?.hasMore ?? false)}
        onPrevious={() => setCursors(cursors.slice(0, -1))}
        onNext={() => {
          const last = entries.at(-1);
          if (last) setCursors([...cursors, last.id]);
        }}
      />
    </>
  );
}

/** An email deleted or marked as spam here. Restore or Not spam brings it back to the inbox. */
function MailTrashRow(props: {
  environmentId: EnvironmentId;
  entry: MailActionEntry;
  onRestored: () => void;
}) {
  const gt = useGT();
  const { undo, disabled } = useMailActions(props.environmentId);
  const [restoring, setRestoring] = useState(false);
  const { entry } = props;
  const subject =
    entry.reason === "sign_in_code" ? gt("Sign-in code") : entry.subject || gt("(No subject)");
  const spam = entry.kind === "spam";
  return (
    <li className="group/sidebar-row flex list-none items-center gap-1.5 rounded-md px-(--sidebar-row-content-inset) py-1.5 text-sidebar-muted-foreground hover:bg-sidebar-row-hover">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-secondary-label">
          {entry.from ?? gt("Unknown sender")}
        </p>
        <p className="truncate text-sm">{subject}</p>
      </div>
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled || restoring}
        aria-label={
          spam ? gt("Not spam: {subject}", { subject }) : gt("Restore {subject}", { subject })
        }
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
        {spam ? gt("Not spam") : gt("Restore")}
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
