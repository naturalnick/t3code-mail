import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MailActor, MailDecidedBy } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";
import { BotIcon, ListFilterIcon } from "lucide-react";

import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

type IconEntry = Pick<
  ProviderInstanceEntry,
  "driverKind" | "displayName" | "accentColor" | "acpRegistryAgentId" | "acpRegistryIconUrl"
>;

const sameIcon = (a: IconEntry, b: IconEntry | undefined) =>
  b !== undefined &&
  a.driverKind === b.driverKind &&
  a.displayName === b.displayName &&
  a.accentColor === b.accentColor &&
  a.acpRegistryAgentId === b.acpRegistryAgentId &&
  a.acpRegistryIconUrl === b.acpRegistryIconUrl;

// Provider status pushes arrive often; rows re-render only when an icon actually changes.
const iconEntriesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const providers =
      get(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
    const next = new Map<string, IconEntry>(
      deriveProviderInstanceEntries(providers).map((entry) => [entry.instanceId, entry]),
    );
    const previous = Option.getOrNull(get.self<ReadonlyMap<string, IconEntry>>());
    const unchanged =
      previous !== null &&
      previous.size === next.size &&
      [...next].every(([id, entry]) => sameIcon(entry, previous.get(id)));
    return unchanged ? previous : next;
  }).pipe(Atom.withLabel(`mail-decider-icons:${environmentId}`)),
);

/**
 * Who sorted an email: the model's own icon, or a filter icon for a rule no model read. A model
 * this environment no longer lists falls back to a generic bot.
 */
export function MailDecider({
  environmentId,
  actor,
  decidedBy,
}: {
  environmentId: EnvironmentId;
  actor: MailActor | null;
  decidedBy: MailDecidedBy | null;
}) {
  const gt = useGT();
  const entries = useAtomValue(iconEntriesAtom(environmentId));
  // A rule with a condition was read by a model, so it shows that model like any other.
  if (actor === "rule" && decidedBy === null) {
    return <ListFilterIcon aria-label={gt("Your rule")} className="size-3 shrink-0" />;
  }
  const entry = decidedBy === null ? undefined : entries.get(decidedBy.instanceId);
  if (entry === undefined) {
    return <BotIcon aria-label={gt("AI")} className="size-3 shrink-0" />;
  }
  return (
    <span role="img" aria-label={decidedBy?.model ?? entry.displayName} className="inline-flex">
      <ProviderInstanceIcon
        driverKind={entry.driverKind}
        displayName={entry.displayName}
        accentColor={entry.accentColor}
        acpRegistryAgentId={entry.acpRegistryAgentId}
        acpRegistryIconUrl={entry.acpRegistryIconUrl}
        size="compact"
        iconClassName="size-3"
      />
    </span>
  );
}
