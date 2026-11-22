import { useGT } from "gt-react";
import type { ReactNode } from "react";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { cn } from "../../lib/utils";
import { isElectron } from "../../env";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

export function MailPage({
  children,
  title,
  toolbar,
  scroll = true,
}: {
  children: ReactNode;
  title?: string;
  toolbar?: ReactNode;
  /** False when the page lays out its own scrolling panels. */
  scroll?: boolean;
}) {
  const gt = useGT();
  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, gt("Mail"))}
      role="main"
      className="h-dvh min-h-0"
    >
      <WorkspacePageHeader electron={isElectron}>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title ?? gt("Mail")}</span>
        {toolbar}
      </WorkspacePageHeader>
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-x-hidden",
          scroll ? "overflow-y-auto" : "overflow-y-hidden",
        )}
      >
        {children}
      </div>
    </SidebarInset>
  );
}
