import type { EnvironmentId, MailDraft } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { mailEnvironment } from "../../state/mail";
import { useMailCommand } from "../settings/MailSettings.commands";
import { toastManager } from "../ui/toast";
import { useMailActions } from "./useMailActions";

/** Discards exactly this draft revision, with an Undo toast. Never touches sent mail. */
export function useDiscardDraft(environmentId: EnvironmentId) {
  const gt = useGT();
  const discard = useMailCommand(
    environmentId,
    mailEnvironment.discardDraft,
    gt("Could not discard draft"),
  );
  const { undo } = useMailActions(environmentId);
  return async (draft: Pick<MailDraft, "id" | "revision">) => {
    const result = await discard.run({ draftId: draft.id, expectedRevision: draft.revision });
    if (!result) return false;
    const { actionId } = result.value;
    if (actionId !== null) {
      const toastId = toastManager.add({
        type: "success",
        title: gt("Draft discarded"),
        actionProps: {
          children: gt("Undo"),
          onClick: () => {
            toastManager.close(toastId);
            void undo([actionId]);
          },
        },
      });
    }
    return true;
  };
}
