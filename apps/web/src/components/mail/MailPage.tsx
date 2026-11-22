import { useGT } from "gt-react";
import type { ReactNode } from "react";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { isElectron } from "../../env";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

export function MailPage({ children }: { children: ReactNode }) {
  const gt = useGT();
  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, gt("Mail"))}
      role="main"
      className="h-dvh min-h-0"
    >
      <WorkspacePageHeader electron={isElectron}>
        <span className="text-sm font-medium">{gt("Mail")}</span>
      </WorkspacePageHeader>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</div>
    </SidebarInset>
  );
}
