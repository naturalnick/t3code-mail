import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { isAtomCommandInterrupted, type AtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { Atom } from "effect/reactivity";
import { useRef, useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatEnvironmentQueryError } from "../../state/query";
import { useMessages } from "gt-react";
import { toastManager } from "../ui/toast";

export function useMailCommand<I, A, E>(
  environmentId: EnvironmentId,
  command: AtomCommand<{ environmentId: EnvironmentId; input: I }, A, E> & {
    permissionAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
  },
  failureTitle: string,
) {
  const allowed = useAtomValue(command.permissionAtom(environmentId));
  const execute = useAtomCommand(command, { label: command.label });
  const messages = useMessages();
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const run = async (input: I) => {
    if (!allowed || running.current) return null;
    running.current = true;
    setPending(true);
    try {
      const result = await execute({ environmentId, input });
      if (result._tag === "Success") return result;
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: failureTitle,
          description: formatEnvironmentQueryError(result.cause, messages),
        });
      }
      return null;
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return { run, pending, disabled: !allowed || pending };
}
