import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { XIcon } from "lucide-react";

import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** An email's chat beside the email, so reading and asking about it share one screen. */
export function MailChatPanel({
  environmentId,
  chatThreadId,
  onClose,
}: {
  environmentId: EnvironmentId;
  chatThreadId: ThreadId;
  onClose: () => void;
}) {
  const gt = useGT();
  // The panel has no terminal or diff view of its own, and mail chats work in an empty folder.
  const unavailable = () =>
    toastManager.add({ type: "info", title: gt("Commands and diffs open only in code chats.") });
  const host: SideChatParentPanel = {
    hostRef: scopeThreadRef(environmentId, chatThreadId),
    openToolDiff: unavailable,
    runShellCommand: unavailable,
  };
  return (
    <div data-side-chat-pane={chatThreadId} className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium">
          <T>Chat</T>
        </h2>
        <Button variant="ghost" size="icon-xs" aria-label={gt("Close chat")} onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <BackgroundThreadContext value>
        <ComposerHandleContext value={null}>
          <ChatView
            environmentId={environmentId}
            threadId={chatThreadId}
            routeKind="server"
            embedded={host}
          />
        </ComposerHandleContext>
      </BackgroundThreadContext>
    </div>
  );
}
