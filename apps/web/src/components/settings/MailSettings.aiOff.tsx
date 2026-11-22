import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";

import { mailEnvironment } from "../../state/mail";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useMailCommand } from "./MailSettings.commands";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

/** Senders whose mail never reaches a model: no sorting, no chat, hidden from agents. */
export function MailAiOff({
  environmentId,
  senders,
}: {
  environmentId: EnvironmentId;
  senders: ReadonlyArray<string>;
}) {
  const gt = useGT();
  const searchable = useSearchableSetting();
  const setSenderAi = useMailCommand(
    environmentId,
    mailEnvironment.setSenderAi,
    gt("Could not change AI for this sender"),
  );
  const [draft, setDraft] = useState("");
  const add = async () => {
    const sender = draft.trim();
    if (!sender) return;
    if (await setSenderAi.run({ sender, enabled: false })) setDraft("");
  };
  return (
    <SettingsSection {...searchable("mail-ai-off")}>
      <SettingsRow
        title={gt("Mail from these senders is never sent to AI")}
        description={gt(
          "It stays in Active for you to handle. Add an address or a whole domain, such as example.com.",
        )}
        control={
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <Input
              aria-label={gt("Address or domain")}
              placeholder="news@example.com"
              value={draft}
              onValueChange={setDraft}
              size="sm"
            />
            <Button type="submit" size="sm" variant="outline" disabled={setSenderAi.disabled}>
              {gt("Add")}
            </Button>
          </form>
        }
      />
      {senders.map((sender) => (
        <SettingsRow
          key={sender}
          title={sender}
          control={
            <Button
              variant="ghost"
              size="xs"
              disabled={setSenderAi.disabled}
              onClick={() => void setSenderAi.run({ sender, enabled: true })}
            >
              {gt("Remove")}
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
