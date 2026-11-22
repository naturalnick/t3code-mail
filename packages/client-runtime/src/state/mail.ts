import {
  WS_METHODS,
  type EnvironmentId,
  type MailStatus,
  type MailStreamEvent,
  type MailThreadId,
  type MailThreadRow,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export interface MailView {
  readonly status: MailStatus;
  readonly threads: ReadonlyMap<MailThreadId, MailThreadRow>;
}

/** Folds the stream; a snapshot (sent again on every reconnect) replaces everything. */
function applyMailEvent(view: MailView | null, event: MailStreamEvent): MailView | null {
  if (event.type === "snapshot") {
    return {
      status: event.status,
      threads: new Map(event.threads.map((thread) => [thread.id, thread])),
    };
  }
  if (view === null) return null;
  if (event.type === "status") return { ...view, status: event.status };
  const threads = new Map(view.threads);
  for (const id of event.removed) threads.delete(id);
  for (const thread of event.upserted) threads.set(thread.id, thread);
  return { ...view, threads };
}

export interface MailSections {
  readonly pinned: ReadonlyArray<MailThreadRow>;
  /** Settle proposals the user has not answered, for the batch "settle these" view. */
  readonly proposals: ReadonlyArray<MailThreadRow>;
  readonly active: ReadonlyArray<MailThreadRow>;
  readonly working: ReadonlyArray<MailThreadRow>;
  readonly snoozed: ReadonlyArray<MailThreadRow>;
  readonly settled: ReadonlyArray<MailThreadRow>;
}

const byEntry = (a: MailThreadRow, b: MailThreadRow) =>
  a.stateAt.localeCompare(b.stateAt) || a.id.localeCompare(b.id);
const byEntryNewest = (a: MailThreadRow, b: MailThreadRow) => byEntry(b, a);
const bySnoozeEnd = (a: MailThreadRow, b: MailThreadRow) =>
  (a.snoozedUntil ?? "~").localeCompare(b.snoozedUntil ?? "~") || byEntry(a, b);

/**
 * Sidebar sections. Rows sort by when they entered their state, never by new mail, so the list
 * does not reshuffle under the pointer. Pinned threads show only in Pinned.
 */
export function groupMailThreads(threads: Iterable<MailThreadRow>): MailSections {
  const pinned: Array<MailThreadRow> = [];
  const active: Array<MailThreadRow> = [];
  const working: Array<MailThreadRow> = [];
  const snoozed: Array<MailThreadRow> = [];
  const settled: Array<MailThreadRow> = [];
  for (const thread of threads) {
    if (thread.pinnedAt !== null && thread.state !== "settled") pinned.push(thread);
    else if (thread.state === "active") active.push(thread);
    else if (thread.state === "working") working.push(thread);
    else if (thread.state === "snoozed") snoozed.push(thread);
    else settled.push(thread);
  }
  pinned.sort((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? "") || byEntry(a, b));
  active.sort(byEntry);
  working.sort(byEntry);
  snoozed.sort(bySnoozeEnd);
  settled.sort(byEntryNewest);
  return {
    pinned,
    proposals: active.filter((thread) => thread.suggestion !== null),
    active,
    working,
    snoozed,
    settled,
  };
}

export function createMailEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const live = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:mail:live",
    tag: WS_METHODS.mailSubscribe,
    transform: (stream) =>
      stream.pipe(
        Stream.scan((): MailView | null => null, applyMailEvent),
        Stream.filter((view): view is MailView => view !== null),
      ),
  });
  const view = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => AsyncResult.getOrElse(get(live({ environmentId, input: {} })), () => null)),
  );
  /** One row, so a thread's detail refreshes when only that thread changed. */
  const row = Atom.family((key: `${EnvironmentId}\u0000${MailThreadId}`) => {
    const [environmentId, threadId] = key.split("\u0000") as [EnvironmentId, MailThreadId];
    return Atom.make((get) => get(view(environmentId))?.threads.get(threadId) ?? null);
  });
  const rowKey = (environmentId: EnvironmentId, threadId: MailThreadId) =>
    `${environmentId}\u0000${threadId}` as const;

  return {
    view,
    thread: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mail:thread",
      tag: WS_METHODS.mailGetThread,
      refreshTrigger: ({ environmentId, input }) => row(rowKey(environmentId, input.threadId)),
    }),
    settled: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mail:settled",
      tag: WS_METHODS.mailListSettled,
      refreshTrigger: ({ environmentId }) =>
        Atom.make((get) => get(view(environmentId))?.status.settledCount ?? 0),
    }),
    search: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mail:search",
      tag: WS_METHODS.mailSearch,
    }),
    actions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mail:actions",
      tag: WS_METHODS.mailListActions,
      refreshTrigger: ({ environmentId }) => view(environmentId),
    }),
    trust: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mail:trust",
      tag: WS_METHODS.mailListTrust,
    }),
    emailMd: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mail:email-md",
      tag: WS_METHODS.mailReadEmailMd,
    }),
    act: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:act",
      tag: WS_METHODS.mailAct,
    }),
    undo: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:undo",
      tag: WS_METHODS.mailUndo,
    }),
    saveDraft: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:save-draft",
      tag: WS_METHODS.mailSaveDraft,
    }),
    discardDraft: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:discard-draft",
      tag: WS_METHODS.mailDiscardDraft,
    }),
    sendDraft: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:send-draft",
      tag: WS_METHODS.mailSendDraft,
    }),
    openSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:open-session",
      tag: WS_METHODS.mailOpenSession,
    }),
    addAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:add-account",
      tag: WS_METHODS.mailAddAccount,
    }),
    updateAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:update-account",
      tag: WS_METHODS.mailUpdateAccount,
    }),
    removeAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:remove-account",
      tag: WS_METHODS.mailRemoveAccount,
    }),
    syncNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:sync-now",
      tag: WS_METHODS.mailSyncNow,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:update-settings",
      tag: WS_METHODS.mailUpdateSettings,
    }),
    setTrust: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:set-trust",
      tag: WS_METHODS.mailSetTrust,
    }),
    writeEmailMd: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:write-email-md",
      tag: WS_METHODS.mailWriteEmailMd,
    }),
    dryRunRule: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:dry-run-rule",
      tag: WS_METHODS.mailDryRunRule,
    }),
    seedVoice: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:seed-voice",
      tag: WS_METHODS.mailSeedVoice,
    }),
    dismissRecap: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mail:dismiss-recap",
      tag: WS_METHODS.mailDismissRecap,
    }),
  };
}
