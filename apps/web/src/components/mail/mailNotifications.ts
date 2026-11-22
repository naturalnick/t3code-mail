import type { AnyRouter } from "@tanstack/react-router";
import type { AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react";
import { m } from "../../i18n/messages";
import { mailEnvironment, mailEnvironmentIdAtom } from "../../state/mail";
import { toastManager } from "../ui/toast";

export function startMailNotifications(registry: AtomRegistry.AtomRegistry, router: AnyRouter) {
  let stopArrivals: (() => void) | undefined;
  let notification: Notification | undefined;
  const stopEnvironment = registry.subscribe(
    mailEnvironmentIdAtom,
    (environmentId) => {
      stopArrivals?.();
      notification?.close();
      if (environmentId === null) return;
      stopArrivals = registry.subscribe(
        mailEnvironment.arrivals({ environmentId, input: {} }),
        (result) => {
          if (result._tag !== "Success" || result.waiting) return;
          const title = m(
            msg("{count, plural, one {One new email} other {# new emails}}", {
              count: result.value.count,
            }),
          );
          const open = () => void router.navigate({ to: "/mail" });
          if (document.visibilityState === "visible" && document.hasFocus()) {
            if (!router.state.location.pathname.startsWith("/mail")) {
              const id = toastManager.add({
                title,
                actionProps: {
                  children: m(msg("Mail")),
                  onClick: () => {
                    toastManager.close(id);
                    open();
                  },
                },
              });
            }
          } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            notification?.close();
            try {
              notification = new Notification(title, { tag: "t3-mail" });
              notification.onclick = () => {
                window.focus();
                open();
                notification?.close();
              };
            } catch {
              // Mobile browsers can expose Notification while only supporting service worker alerts.
            }
          }
        },
      );
    },
    { immediate: true },
  );
  return () => {
    stopArrivals?.();
    stopEnvironment();
    notification?.close();
  };
}
