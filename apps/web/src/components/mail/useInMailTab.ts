import { useLocation } from "@tanstack/react-router";

import { useShownThreadRouteTarget } from "../../hooks/useShownThreadRouteTarget";
import { useIsMailChatThread } from "../../state/mail";
import { isAppModalReturnInMail, isMailPath } from "../sidebar/mainAppLocation";

/** Mail pages, a mail chat session, and Settings or Usage opened over either. */
export function useInMailTab(): boolean {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { shownTarget, modalOpen } = useShownThreadRouteTarget();
  const mailChat = useIsMailChatThread(
    shownTarget?.kind === "server" ? shownTarget.threadRef : null,
  );
  if (mailChat) return true;
  return modalOpen ? isAppModalReturnInMail() : isMailPath(pathname);
}
