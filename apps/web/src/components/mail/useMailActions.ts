import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import type { EnvironmentId, MailThreadAction, MailThreadId } from "@t3tools/contracts";
import { msg, useMessages } from "gt-react";

import { mailEnvironment } from "../../state/mail";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

const unavailable = Atom.make(false);

/** Thread actions with an Undo toast; failures are reported by the command itself. */
export function useMailActions(environmentId: EnvironmentId | null) {
  const resolve = useMessages();
  const allowed = useAtomValue(
    environmentId === null ? unavailable : mailEnvironment.act.permissionAtom(environmentId),
  );
  const actCommand = useAtomCommand(mailEnvironment.act, { label: "mail act" });
  const undoCommand = useAtomCommand(mailEnvironment.undo, { label: "mail undo" });

  const undo = async (actionIds: ReadonlyArray<number>) => {
    if (environmentId === null) return false;
    // Newest first, so each undo restores the state the next one expects.
    for (const actionId of actionIds.toReversed()) {
      const result = await undoCommand({ environmentId, input: { actionId } });
      if (result._tag !== "Success") return false;
    }
    return true;
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
    if (result._tag !== "Success") return null;
    const actionIds = result.value.actionIds;
    if (done !== undefined && actionIds.length > 0) {
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
    }
    return actionIds;
  };

  return { act, undo, disabled: !allowed };
}
