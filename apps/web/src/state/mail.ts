import { useAtomValue } from "@effect/atom-react";
import {
  createMailEnvironmentAtoms,
  groupMailThreads,
  type MailSections,
} from "@t3tools/client-runtime/state/mail";
import {
  MAIL_SESSION_PROJECT_ID,
  type EnvironmentId,
  type MailStatus,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations, environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentThreadShells } from "./threads";

export const mailEnvironment = createMailEnvironmentAtoms(connectionAtomRuntime);

/**
 * Mail lives on one environment: the primary one when its server has Mail, otherwise the
 * first connected server that does.
 */
export const mailEnvironmentIdAtom = Atom.make((get): EnvironmentId | null => {
  const supports = (environmentId: EnvironmentId) =>
    get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
      .capabilities.mail === true;
  const primary = get(primaryEnvironmentIdAtom);
  if (primary !== null && supports(primary)) return primary;
  return get(environmentSummaries.connectedEnvironmentIdsAtom).find(supports) ?? null;
}).pipe(Atom.withLabel("web-mail:environment"));

/** A mail chat session is a normal thread in the Mail project; it shows in the Mail tab. */
export function readIsMailChatThread(ref: ScopedThreadRef): boolean {
  return (
    appAtomRegistry.get(environmentThreadShells.quietThreadShellAtom(ref))?.projectId ===
    MAIL_SESSION_PROJECT_ID
  );
}

const EMPTY_SHELL = Atom.make(null).pipe(Atom.withLabel("web-mail:empty-shell"));

export function useIsMailChatThread(ref: ScopedThreadRef | null): boolean {
  return (
    useAtomValue(ref === null ? EMPTY_SHELL : environmentThreadShells.quietThreadShellAtom(ref))
      ?.projectId === MAIL_SESSION_PROJECT_ID
  );
}

export function useMailEnvironmentId(): EnvironmentId | null {
  return useAtomValue(mailEnvironmentIdAtom);
}

const EMPTY_VIEW = Atom.make(null).pipe(Atom.withLabel("web-mail:empty-view"));

const threadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(mailEnvironment.view(environmentId))?.threads ?? null),
);

const sectionsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): MailSections | null => {
    const threads = get(threadsAtom(environmentId));
    return threads === null ? null : groupMailThreads(threads.values());
  }),
);

/** Null until the first snapshot arrives. */
export function useMailStatus(environmentId: EnvironmentId | null): MailStatus | null {
  return (
    useAtomValue(environmentId === null ? EMPTY_VIEW : mailEnvironment.view(environmentId))
      ?.status ?? null
  );
}

export function useMailSections(environmentId: EnvironmentId | null): MailSections | null {
  return useAtomValue(environmentId === null ? EMPTY_VIEW : sectionsAtom(environmentId));
}
