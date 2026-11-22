import { type EnvironmentId, mailSenderEntry } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { mailEnvironment, useMailStatus } from "../../state/mail";
import { useMailCommand } from "../settings/MailSettings.commands";
import { toastManager } from "../ui/toast";

const EMPTY: ReadonlyArray<string> = [];

/**
 * Whether AI may read a sender's mail, and the switch for it. Turning AI back on removes the exact
 * entry that covers the sender, which may be a whole domain, so the label names that domain.
 */
export function useSenderAi(environmentId: EnvironmentId) {
  const gt = useGT();
  const senders = useMailStatus(environmentId)?.settings.aiExcludedSenders ?? EMPTY;
  const command = useMailCommand(
    environmentId,
    mailEnvironment.setSenderAi,
    gt("Could not change AI for this sender"),
  );
  const entryFor = (address: string) => mailSenderEntry(address, senders);
  const toggle = async (address: string) => {
    const entry = entryFor(address);
    const sender = entry ?? address.trim().toLowerCase();
    const enabled = entry !== null;
    if (!(await command.run({ sender, enabled }))) return;
    const toastId = toastManager.add({
      type: "success",
      title: enabled ? gt("AI on for {sender}", { sender }) : gt("AI off for {sender}", { sender }),
      actionProps: {
        children: gt("Undo"),
        onClick: () => {
          toastManager.close(toastId);
          void command.run({ sender, enabled: !enabled });
        },
      },
    });
  };
  const toggleLabel = (address: string) => {
    const entry = entryFor(address);
    if (entry === null) return gt("Turn off AI for this sender");
    return entry.toLowerCase() === address.trim().toLowerCase()
      ? gt("Turn on AI for this sender")
      : gt("Turn on AI for {sender}", { sender: entry });
  };
  return { entryFor, toggle, toggleLabel, disabled: command.disabled };
}
