import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MailSettings as MailPreferences,
  MailStatus,
  MailUsage,
} from "@t3tools/contracts";
import { AuthDiagnosticsReadScope } from "@t3tools/contracts";
import { pickModelSelection } from "@t3tools/shared/model";
import { msg, useGT, useLocale, useMessages } from "gt-react";
import { memo, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { mailEnvironment, useMailEnvironmentId, useMailStatus } from "../../state/mail";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { MailAccounts } from "./MailSettings.accounts";
import { useMailCommand } from "./MailSettings.commands";
import { insertToneNotes, mailUsageShare } from "./MailSettings.logic";
import { MailAiOff } from "./MailSettings.aiOff";
import { MailRules } from "./MailSettings.rules";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

type SettingsProps = { environmentId: EnvironmentId; settings: MailPreferences };

function MailModels({ environmentId, settings }: SettingsProps) {
  const gt = useGT();
  const searchable = useSearchableSetting();
  const environment = useEnvironmentSettings(environmentId);
  const providers = (
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS
  ).filter((provider) => provider.supportsTextGeneration !== false);
  const entries = providerInstanceEntriesFor(providers, environment, null);
  const save = useMailCommand(
    environmentId,
    mailEnvironment.updateSettings,
    gt("Could not save mail model"),
  );
  return (
    <SettingsSection {...searchable("mail-models")}>
      {(["defaultModelSelection", "escalationModelSelection"] as const).map((key) => {
        const escalation = key === "escalationModelSelection";
        const title = escalation ? gt("Escalation model") : gt("Default mail model");
        const selection = settings[key];
        const instanceId = selection?.instanceId ?? entries[0]?.instanceId;
        return (
          <SettingsRow
            key={key}
            title={title}
            description={
              escalation
                ? gt("Reviews low-confidence decisions and mail from people you’ve replied to.")
                : undefined
            }
            control={
              <>
                {instanceId ? (
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={instanceId}
                    model={selection?.model ?? ""}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={getCustomModelOptionsByInstance(
                      environment,
                      providers,
                      instanceId,
                      selection?.model,
                    )}
                    isComposerOwned={false}
                    disabled={save.disabled || entries.length === 0}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel={title}
                    {...(selection
                      ? {}
                      : { triggerLabel: escalation ? gt("None") : gt("Choose model") })}
                    onInstanceModelChange={(id, model) =>
                      void save.run({ [key]: pickModelSelection(selection, id, model) })
                    }
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {gt("No providers available")}
                  </span>
                )}
                {escalation && selection && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={save.disabled}
                    onClick={() => void save.run({ escalationModelSelection: null })}
                  >
                    {gt("Clear")}
                  </Button>
                )}
              </>
            }
          />
        );
      })}
    </SettingsSection>
  );
}

function NumericSetting({
  label,
  value,
  min,
  max,
  disabled,
  nullable = false,
  onSave,
}: {
  label: string;
  value: number | null;
  min: number;
  max?: number;
  disabled: boolean;
  nullable?: boolean;
  onSave: (value: number | null) => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState(value);
  const valid =
    draft === null
      ? nullable
      : Number.isSafeInteger(draft) && draft >= min && draft <= (max ?? Number.MAX_SAFE_INTEGER);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && valid && draft !== value) onSave(draft);
      }}
    >
      <div className="w-28">
        <NumberField
          value={draft}
          min={min}
          max={max ?? Number.MAX_SAFE_INTEGER}
          step={1}
          size="sm"
          disabled={disabled}
          onValueChange={setDraft}
        >
          <NumberFieldGroup>
            <NumberFieldInput aria-label={label} placeholder={nullable ? gt("Off") : undefined} />
          </NumberFieldGroup>
        </NumberField>
      </div>
      {nullable && draft !== null && (
        <Button
          variant="ghost"
          size="xs"
          disabled={disabled}
          onClick={() => {
            setDraft(null);
            if (value !== null) onSave(null);
          }}
        >
          {gt("Turn off")}
        </Button>
      )}
      {draft !== value && (
        <Button type="submit" variant="outline" size="xs" disabled={disabled || !valid}>
          {gt("Save")}
        </Button>
      )}
    </form>
  );
}

function Usage({ environmentId, usage }: { environmentId: EnvironmentId; usage: MailUsage }) {
  const gt = useGT();
  const locale = useLocale();
  const searchable = useSearchableSetting();
  const save = useMailCommand(
    environmentId,
    mailEnvironment.updateSettings,
    gt("Could not save weekly token cap"),
  );
  const capLabel = gt("Weekly token cap");
  const canReadUsage = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const summary = useEnvironmentQuery(
    canReadUsage && usage.providerWindow
      ? serverEnvironment.usageSummary({ environmentId, input: usage.providerWindow })
      : null,
  );
  const fraction = mailUsageShare(environmentId, usage.tokens, summary.data);
  const estimate = (usage.estimatedTokens ?? usage.tokens) > 0 ? "≈" : "";
  const tokens = estimate + usage.tokens.toLocaleString(locale);
  const cap = usage.cap;
  return (
    <SettingsSection {...searchable("mail-usage")}>
      <SettingsRow
        title={capLabel}
        control={
          <NumericSetting
            key={cap ?? "off"}
            label={capLabel}
            value={cap}
            min={0}
            nullable
            disabled={save.disabled}
            onSave={(weeklyTokenCap) => void save.run({ weeklyTokenCap })}
          />
        }
      />
      <SettingsRow
        title={
          cap === null
            ? gt("{tokens} tokens this week", { tokens })
            : gt("{tokens} of {cap} tokens this week", { tokens, cap: cap.toLocaleString(locale) })
        }
        description={
          fraction === null
            ? undefined
            : gt("Email used {percent} of your usage this week.", {
                percent:
                  estimate +
                  new Intl.NumberFormat(locale, {
                    style: "percent",
                    maximumFractionDigits: 1,
                  }).format(fraction),
              })
        }
        status={usage.capped ? gt("Cap reached. Model triage is paused.") : undefined}
      >
        {cap !== null && (
          <progress
            aria-label={gt("Weekly mail token usage")}
            max={Math.max(1, cap)}
            value={cap === 0 ? 1 : Math.min(usage.tokens, cap)}
            className="mb-2 h-1.5 w-full accent-primary"
          />
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

function Behavior({ environmentId, settings }: SettingsProps) {
  const gt = useGT();
  const m = useMessages();
  const searchable = useSearchableSetting();
  const save = useMailCommand(
    environmentId,
    mailEnvironment.updateSettings,
    gt("Could not save mail settings"),
  );
  const switches = [
    ["syncEnabled", msg("Sync mail")],
    ["serverMirroring", msg("Archive on the mail server when settled")],
    ["recapEnabled", msg("Daily recap")],
    ["notificationsEnabled", msg("Notifications")],
  ] as const;
  const nudges = [
    ["nudgeReplyDays", msg("Days before nudging an unanswered email")],
    ["nudgeWaitingDays", msg("Days before nudging when waiting for a reply")],
  ] as const;
  return (
    <SettingsSection {...searchable("mail-behavior")}>
      {switches.map(([key, label]) => (
        <SettingsRow
          key={key}
          title={m(label)}
          control={
            <Switch
              checked={settings[key]}
              aria-label={m(label)}
              disabled={save.disabled}
              onCheckedChange={(checked) => {
                if (
                  key === "notificationsEnabled" &&
                  checked &&
                  typeof Notification !== "undefined" &&
                  Notification.permission === "default"
                ) {
                  void Notification.requestPermission().catch(() => {});
                }
                void save.run({ [key]: checked });
              }}
            />
          }
        />
      ))}
      {nudges.map(([key, label]) => (
        <SettingsRow
          key={key}
          title={m(label)}
          control={
            <NumericSetting
              key={settings[key]}
              label={m(label)}
              value={settings[key]}
              min={1}
              max={60}
              disabled={save.disabled}
              onSave={(n) => {
                if (n !== null) void save.run({ [key]: n });
              }}
            />
          }
        />
      ))}
    </SettingsSection>
  );
}

function CodeCleanup({ environmentId, settings }: SettingsProps) {
  const gt = useGT();
  const save = useMailCommand(
    environmentId,
    mailEnvironment.updateSettings,
    gt("Could not save mail settings"),
  );
  const title = gt("Automatically trash sign-in codes");
  return (
    <>
      <SettingsRow
        title={title}
        description={gt(
          "Move new code emails to Trash at the earliest of these times or the code’s stated expiry.",
        )}
        control={
          <Switch
            aria-label={title}
            checked={settings.codeCleanupEnabled}
            disabled={save.disabled}
            onCheckedChange={(codeCleanupEnabled) => void save.run({ codeCleanupEnabled })}
          />
        }
      />
      {settings.codeCleanupEnabled &&
        (
          [
            ["codeInboxMinutes", gt("Minutes after delivery")],
            ["codeReadMinutes", gt("Minutes after reading")],
          ] as const
        ).map(([key, label]) => (
          <SettingsRow
            key={key}
            title={label}
            control={
              <NumericSetting
                key={settings[key]}
                label={label}
                value={settings[key]}
                min={1}
                max={1440}
                disabled={save.disabled}
                onSave={(value) => {
                  if (value !== null) void save.run({ [key]: value });
                }}
              />
            }
          />
        ))}
    </>
  );
}

function Memory({ environmentId, path }: { environmentId: EnvironmentId; path: string }) {
  const gt = useGT();
  const searchable = useSearchableSetting();
  const query = useEnvironmentQuery(mailEnvironment.emailMd({ environmentId, input: {} }));
  const save = useMailCommand(
    environmentId,
    mailEnvironment.writeEmailMd,
    gt("Could not save EMAIL.md"),
  );
  const seed = useMailCommand(
    environmentId,
    mailEnvironment.seedVoice,
    gt("Could not draft voice notes"),
  );
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null && draft === query.data?.content) setDraft(null);
  const content = draft ?? query.data?.content ?? "";
  const disabled = !query.data || save.disabled;
  return (
    <SettingsSection {...searchable("mail-memory")}>
      <SettingsRow title={gt("EMAIL.md")} description={query.data?.path ?? path}>
        {query.error && (
          <div className="flex items-center gap-2 text-xs" role="alert">
            {query.error}
            <Button size="xs" variant="outline" onClick={query.refresh}>
              {gt("Retry")}
            </Button>
          </div>
        )}
        <div className="grid gap-2 py-2">
          <Textarea
            rows={10}
            aria-label={gt("EMAIL.md contents")}
            value={content}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || seed.disabled}
              onClick={async () => {
                const result = await seed.run({});
                if (result)
                  setDraft((current) => insertToneNotes(current ?? content, result.value.notes));
              }}
            >
              {gt("Draft voice notes from sent mail")}
            </Button>
            <Button
              size="sm"
              disabled={disabled || seed.pending || content === query.data?.content}
              onClick={async () => {
                if (await save.run({ content })) query.refresh();
              }}
            >
              {gt("Save")}
            </Button>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

export function MailSettings() {
  const gt = useGT();
  const environmentId = useMailEnvironmentId();
  const status = useMailStatus(environmentId);
  return (
    <SettingsPageContainer>
      {environmentId === null || status === null ? (
        <SettingsSection title={gt("Mail")}>
          <SettingsUnavailableGroup
            message={
              environmentId === null
                ? gt("No connected environment supports Mail.")
                : gt("Loading mail settings…")
            }
          >
            {null}
          </SettingsUnavailableGroup>
        </SettingsSection>
      ) : (
        <MailSections key={environmentId} environmentId={environmentId} status={status} />
      )}
    </SettingsPageContainer>
  );
}

const MailSections = memo(function MailSections({
  environmentId,
  status,
}: {
  environmentId: EnvironmentId;
  status: MailStatus;
}) {
  const { settings } = status;
  return (
    <>
      <MailAccounts environmentId={environmentId} accounts={status.accounts} />
      <MailModels environmentId={environmentId} settings={settings} />

      <MailRules environmentId={environmentId} rules={settings.rules}>
        <CodeCleanup environmentId={environmentId} settings={settings} />
      </MailRules>
      <MailAiOff environmentId={environmentId} senders={settings.aiExcludedSenders} />
      <Usage environmentId={environmentId} usage={status.usage} />
      <Behavior environmentId={environmentId} settings={settings} />
      <Memory environmentId={environmentId} path={status.emailMdPath} />
    </>
  );
});
