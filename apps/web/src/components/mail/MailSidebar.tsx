import type {
  EnvironmentId,
  MailThreadId,
  MailSettleReason,
  MailThreadRow,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { InboxIcon, ListFilterIcon, SearchIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { cn } from "../../lib/utils";
import {
  mailEnvironment,
  useMailEnvironmentId,
  useMailSections,
  useMailStatus,
} from "../../state/mail";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
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
import { settleReasonLabel } from "./mailPresentation";
import { MailSidebarRow } from "./MailSidebarRow";
import { useMailActions } from "./useMailActions";

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
            <SettledShelf
              environmentId={environmentId}
              expanded={settledOpen}
              onToggle={() => setSettledOpen((open) => !open)}
              recent={sections.settled}
              renderRow={row}
            />
          </ul>
        )}
      </SidebarGroup>
    </SidebarContent>
  );
}

function MailShelf(props: {
  label: string;
  count: number;
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
          accessory={<span className="font-normal tabular-nums">{props.count}</span>}
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
