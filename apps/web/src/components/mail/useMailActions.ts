import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import type { EnvironmentId, MailThreadAction, MailThreadId } from "@t3tools/contracts";
import { msg, useMessages } from "gt-react";

import { formatEnvironmentQueryError } from "../../state/query";
import { mailEnvironment } from "../../state/mail";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

const unavailable = Atom.make(false);

/** Thread actions with a shared Undo toast. */
export function useMailActions(environmentId: EnvironmentId | null) {
  const resolve = useMessages();
  const allowed = useAtomValue(
    environmentId === null ? unavailable : mailEnvironment.act.permissionAtom(environmentId),
  );
  const actCommand = useAtomCommand(mailEnvironment.act, { label: "mail act" });
  const undoCommand = useAtomCommand(mailEnvironment.undo, { label: "mail undo" });

  const reportFailure = (
    result: Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }>,
  ) => {
    if (!isAtomCommandInterrupted(result))
      toastManager.add({
        type: "error",
        title: formatEnvironmentQueryError(result.cause, resolve),
      });
  };

  const undo = async (actionIds: ReadonlyArray<number>) => {
    if (environmentId === null) return false;
    // Newest first, so each undo restores the state the next one expects.
    for (const actionId of actionIds.toReversed()) {
      const result = await undoCommand({ environmentId, input: { actionId } });
      if (result._tag !== "Success") {
        reportFailure(result);
        return false;
      }
    }
    return true;
  };

  const showUndo = (actionIds: ReadonlyArray<number>, done: string) => {
    if (!actionIds.length) return;
    const toastId = toastManager.add({
      type: "success",
      title: done,
      actionProps: {
        children: resolve(msg("Undo")),
        onClick: () => {
          toastManager.close(toastId);
          void undo(actionIds);
        },
      },
    });
  };

  const act = async (
    threadIds: ReadonlyArray<MailThreadId>,
    action: MailThreadAction,
    done?: string,
  ): Promise<ReadonlyArray<number> | null> => {
    if (environmentId === null || threadIds.length === 0) return null;
    const result = await actCommand({
      environmentId,
      input: { threadIds: [...threadIds], action },
    });
    if (result._tag !== "Success") {
      reportFailure(result);
      return null;
    }
    const actionIds = result.value.actionIds;
    if (done !== undefined) showUndo(actionIds, done);
    return actionIds;
  };

  return { act, undo, showUndo, disabled: !allowed };
}
