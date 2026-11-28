import { ArrowLeftIcon, ArrowRightIcon, ChartNoAxesColumnIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { T, useGT } from "gt-react";
import { memo } from "react";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { useAtomValue } from "@effect/atom-react";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  navigateHistory,
  useCanNavigateHistory,
  type HistoryDirection,
} from "../../navigationHistory";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { cn } from "../../lib/utils";
import { useIssuesSupported, usePullRequestsSupported } from "../../state/environments";
import { T3Wordmark } from "../T3Wordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { useMailEnvironmentId } from "../../state/mail";
import { useInMailTab } from "../mail/useInMailTab";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { readIssueListPreferences } from "../issue/issueListPreferences";
import { IssueGlyph } from "../issue/issuePresentation";
import { isSidebarUtilityPage, useNavigateToMainApp, useSwitchAppTab } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

/** Code and Mail tabs appear once a server has Mail; without it the brand reads "T3 Code". */
function useHasWorkspaceTabs() {
  const connected = useMailEnvironmentId();
  const inMail = useInMailTab();
  return { shown: connected !== null || inMail, inMail };
}

/** A two-position switch: the thumb slides to the active side, and clicking the active side flips it. */
function WorkspaceTabs({ inMail, onBackdrop }: { inMail: boolean; onBackdrop: boolean }) {
  const switchTab = useSwitchAppTab();
  const side = cn(
    "relative z-10 flex h-6 cursor-pointer select-none items-center justify-center rounded-full px-3 font-medium text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    // On a backdrop image both labels stay white so neither gets lost in the glare.
    onBackdrop
      ? "text-white not-data-pressed:hover:bg-white/10"
      : "text-muted-foreground hover:text-foreground data-pressed:text-foreground",
  );
  return (
    <ToggleGroupPrimitive
      className={cn(
        "relative inline-grid grid-cols-2 rounded-full p-0.5 [-webkit-app-region:no-drag]",
        onBackdrop ? "bg-black/25 ring-1 ring-white/20 ring-inset" : "bg-input/50",
      )}
      value={[inMail ? "mail" : "code"]}
      onValueChange={([tab]) => {
        void switchTab(tab === "mail" || tab === "code" ? tab : inMail ? "code" : "mail");
      }}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-full transition-transform duration-200 ease-out motion-reduce:transition-none",
          onBackdrop ? "bg-white/30" : "bg-background shadow-xs/10 dark:bg-input",
          inMail && "translate-x-full",
        )}
      />
      <TogglePrimitive value="code" className={side}>
        <T>Code</T>
      </TogglePrimitive>
      <TogglePrimitive value="mail" className={side}>
        <T>Mail</T>
      </TogglePrimitive>
    </ToggleGroupPrimitive>
  );
}

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const tabs = useHasWorkspaceTabs();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const gt = useGT();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode,
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <>
      <div
        className={cn(
          "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
          isElectron && "drag-region",
        )}
      >
        {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
        <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
          <SidebarTrigger
            variant={backdropVariant ? "media-navigation" : "ghost"}
            className="relative top-auto translate-y-0"
            aria-label={gt("Toggle main sidebar")}
          />
        </div>
        <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
          <div className="flex shrink-0 items-center gap-1">
            <SidebarBrand onBackdrop={backdropVariant !== null} product={!tabs.shown} />
            {tabs.shown ? (
              <WorkspaceTabs inMail={tabs.inMail} onBackdrop={backdropVariant !== null} />
            ) : null}
            {isElectron ? (
              <div className="hidden items-center md:flex">
                <HistoryNavigationButton direction="back" onBackdrop={backdropVariant !== null} />
                <HistoryNavigationButton
                  direction="forward"
                  onBackdrop={backdropVariant !== null}
                />
              </div>
            ) : null}
          </div>
          {pillLabel ? (
            <div className="ml-1 flex h-7 items-center">
              <Badge data-environment-identification="pill" size="sm" variant="secondary">
                {pillLabel}
              </Badge>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
});

export function SidebarBrandWidthProbe({
  isElectron,
  onWidthChange,
}: {
  isElectron: boolean;
  onWidthChange: (width: number) => void;
}) {
  const tabs = useHasWorkspaceTabs();
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex gap-1">
        <SidebarBrandMark onBackdrop={false} product={!tabs.shown} />
        {tabs.shown ? <WorkspaceTabs inMail={tabs.inMail} onBackdrop={false} /> : null}
        {isElectron ? <div className="w-[calc(2*var(--workspace-titlebar-control-size))]" /> : null}
      </div>
    </div>
  );
}

function HistoryNavigationButton({
  direction,
  onBackdrop,
}: {
  direction: HistoryDirection;
  onBackdrop: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const enabled = useCanNavigateHistory(direction);
  const gt = useGT();
  const label = direction === "back" ? gt("Go back") : gt("Go forward");
  const shortcutLabel = shortcutLabelForCommand(
    keybindings,
    direction === "back" ? "navigation.back" : "navigation.forward",
  );
  const Icon = direction === "back" ? ArrowLeftIcon : ArrowRightIcon;
  return (
    <SharedTooltipTrigger
      render={
        <Button
          aria-label={label}
          className={cn(
            "[-webkit-app-region:no-drag]",
            onBackdrop && "relative top-auto translate-y-0",
          )}
          disabled={!enabled}
          onClick={() => navigateHistory(direction)}
          size="icon-sm"
          variant={onBackdrop ? "media-navigation" : "ghost"}
        />
      }
      label={
        <>
          {label}
          {shortcutLabel ? ` (${shortcutLabel})` : ""}
        </>
      }
      side="bottom"
    >
      <Icon className="size-3.5" />
    </SharedTooltipTrigger>
  );
}

function SidebarBrand({ onBackdrop, product }: { onBackdrop: boolean; product: boolean }) {
  const gt = useGT();
  return (
    <Link
      aria-label={gt("T3 Code home")}
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <SidebarBrandMark onBackdrop={onBackdrop} product={product} />
    </Link>
  );
}

function SidebarBrandMark({ onBackdrop, product }: { onBackdrop: boolean; product: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
      <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />
      {product ? (
        <span
          className={cn(
            "truncate [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1",
            onBackdrop ? "text-white/70" : "text-muted-foreground",
          )}
        >
          {/* oxlint-disable-next-line t3code/no-untranslated-copy -- product wordmark */}
          {"Code"}
        </span>
      ) : null}
    </span>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <SharedTooltipTrigger
        render={
          <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
            {icon}
          </SidebarMenuButton>
        }
        label={label}
      />
    </SidebarMenuItem>
  );
}

const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const gt = useGT();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handlePullRequestsClick = () => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  };
  const handleIssuesClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/issues", search: readIssueListPreferences() });
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  };

  const handleUsageClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  };

  const handleBackClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>
              <T>Back</T>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label={gt("Settings")}
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label={gt("Pull requests")}
              onClick={handlePullRequestsClick}
            />
          ) : null}
          {issuesSupported ? (
            <SidebarUtilityItem
              icon={<IssueGlyph.issue />}
              label={gt("Issues", { $context: "sidebar link to the list of issues" })}
              onClick={handleIssuesClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label={gt("Usage")}
            onClick={handleUsageClick}
          />
        </>
      )}
      <SidebarThreadUndoNotice />
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
