import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, MailThreadId, MailUnsubscribeOptions } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useRef, useState } from "react";

import { mailEnvironment } from "../../state/mail";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

type State =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly options: MailUnsubscribeOptions | null }
  | { readonly phase: "sending"; readonly options: MailUnsubscribeOptions }
  | {
      readonly phase: "failed";
      readonly error: string;
      readonly options: MailUnsubscribeOptions | null;
    };

const webUrl = (url: string | null | undefined) => (url && /^https?:\/\//i.test(url) ? url : null);

/** Unsubscribe asks the server what the sender offers, and acts only after the user confirms. */
export function useMailUnsubscribe(environmentId: EnvironmentId) {
  const gt = useGT();
  const messages = useMessages();
  const readOptions = useAtomCommand(mailEnvironment.unsubscribeOptions, {
    label: "mail unsubscribe options",
    reportFailure: false,
  });
  const runUnsubscribe = useAtomCommand(mailEnvironment.unsubscribe, {
    label: "mail unsubscribe",
    reportFailure: false,
  });
  const [threadId, setThreadId] = useState<MailThreadId | null>(null);
  const [state, setState] = useState<State>({ phase: "loading" });
  const request = useRef(0);

  const close = () => {
    request.current += 1;
    setThreadId(null);
  };

  const open = async (id: MailThreadId) => {
    const current = ++request.current;
    setThreadId(id);
    setState({ phase: "loading" });
    const result = await readOptions({ environmentId, input: { threadId: id } });
    if (current !== request.current || isAtomCommandInterrupted(result)) return;
    setState(
      result._tag === "Success"
        ? { phase: "ready", options: result.value }
        : {
            phase: "failed",
            error: formatEnvironmentQueryError(result.cause, messages),
            options: null,
          },
    );
  };

  const confirm = async (options: MailUnsubscribeOptions) => {
    if (threadId === null || options.method === "link") return;
    const current = request.current;
    setState({ phase: "sending", options });
    const result = await runUnsubscribe({
      environmentId,
      input: { threadId, method: options.method, confirmation: options.confirmation },
    });
    if (current !== request.current) return;
    if (result._tag === "Success") {
      close();
      toastManager.add({
        type: "success",
        title: options.method === "one_click" ? gt("Unsubscribed") : gt("Unsubscribe request sent"),
      });
      return;
    }
    setState({
      phase: "failed",
      error: formatEnvironmentQueryError(result.cause, messages),
      options,
    });
  };

  const unsubscribeLabel = gt("Unsubscribe", { $context: "verb, confirms the request" });
  const options = state.phase === "loading" ? null : state.options;
  const pageUrl = webUrl(options?.pageUrl);
  const description =
    state.phase === "loading" ? null : state.phase === "failed" ? (
      state.error
    ) : options === null ? (
      <T>This email doesn’t include a way to unsubscribe.</T>
    ) : options.method === "one_click" ? (
      gt("Mail asks {target} to stop sending you this mail.", { target: options.target })
    ) : options.method === "email" ? (
      gt("Mail sends an unsubscribe request from your address to {target}.", {
        target: options.target,
      })
    ) : (
      gt("{target} handles unsubscribing on its website.", { target: options.target })
    );

  const dialog = (
    <AlertDialog
      open={threadId !== null}
      onOpenChange={(next) => {
        if (!next && state.phase !== "sending") close();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {options
              ? gt("Unsubscribe from {sender}?", { sender: options.sender })
              : unsubscribeLabel}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {state.phase === "loading" ? <Spinner className="size-4" /> : description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {options?.emailPreview && (
          <dl className="max-h-48 overflow-auto text-sm wrap-anywhere">
            <dt className="text-xs text-muted-foreground">{gt("Subject")}</dt>
            <dd>{options.emailPreview.subject}</dd>
            <dt className="mt-2 text-xs text-muted-foreground">{gt("Message")}</dt>
            <dd className="whitespace-pre-wrap">{options.emailPreview.body}</dd>
          </dl>
        )}
        <AlertDialogFooter>
          <AlertDialogClose
            disabled={state.phase === "sending"}
            render={<Button variant="outline" />}
          >
            <T>Cancel</T>
          </AlertDialogClose>
          {state.phase === "ready" && options && options.method !== "link" ? (
            <Button onClick={() => void confirm(options)}>{unsubscribeLabel}</Button>
          ) : state.phase === "sending" ? (
            <Button disabled>
              <Spinner size="sm" />
              {unsubscribeLabel}
            </Button>
          ) : pageUrl && (state.phase === "failed" || options?.method === "link") ? (
            <Button
              render={<a href={pageUrl} target="_blank" rel="noopener noreferrer" />}
              onClick={close}
            >
              <T>Open website</T>
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );

  return { open, dialog };
}
