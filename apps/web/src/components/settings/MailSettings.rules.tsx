import type { EnvironmentId, MailDryRunRuleResult, MailRule } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { useId, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { mailEnvironment } from "../../state/mail";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import { Switch } from "../ui/switch";
import { useMailCommand } from "./MailSettings.commands";
import { normalizeRule } from "./MailSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const matchFields = [
  ["from", msg("From")],
  ["domain", msg("Domain")],
  ["subjectContains", msg("Subject contains")],
  ["listId", msg("List ID")],
] as const;
const actions = {
  settle: msg("Settle"),
  keep: msg("Keep"),
  never_show: msg("Never show"),
} satisfies Record<MailRule["action"], string>;
const reasons = {
  fyi: msg("FYI"),
  receipt: msg("Receipt"),
  noise: msg("Noise"),
  done: msg("Done"),
  replied: msg("Replied"),
  archived: msg("Archived"),
} satisfies Record<MailRule["reason"], string>;
const actionOptions = ["settle", "keep", "never_show"] as const;
const reasonOptions = ["fyi", "receipt", "noise", "done"] as const;

function RuleDialog({
  environmentId,
  initial,
  adding,
  disabled,
  onSave,
  onClose,
}: {
  environmentId: EnvironmentId;
  initial: MailRule;
  adding: boolean;
  disabled: boolean;
  onSave: (rule: MailRule) => Promise<void>;
  onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const rule = normalizeRule(draft);
  const preview = useMailCommand(
    environmentId,
    mailEnvironment.dryRunRule,
    gt("Could not preview rule"),
  );
  const [sample, setSample] = useState<{ draft: MailRule; result: MailDryRunRuleResult } | null>(
    null,
  );
  const result = sample?.draft === draft ? sample.result : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{adding ? gt("Add rule") : gt("Edit rule")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={disabled} className="grid gap-3">
            <legend className="mb-2 text-xs text-muted-foreground">
              {gt("Set at least one condition. All conditions must match.")}
            </legend>
            {matchFields.map(([key, label]) => (
              <div key={key} className="grid gap-1.5">
                <Label htmlFor={id + key}>{m(label)}</Label>
                <Input
                  id={id + key}
                  value={draft.match[key] ?? ""}
                  onChange={(event) =>
                    setDraft({ ...draft, match: { ...draft.match, [key]: event.target.value } })
                  }
                />
              </div>
            ))}
            <div className="flex flex-wrap gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor={id + "action"}>{gt("Action")}</Label>
                <Select
                  value={draft.action}
                  onValueChange={(value) => {
                    if (value) setDraft({ ...draft, action: value });
                  }}
                >
                  <SelectTrigger id={id + "action"}>{m(actions[draft.action])}</SelectTrigger>
                  <SelectPopup>
                    {actionOptions.map((action) => (
                      <SelectItem key={action} value={action}>
                        {m(actions[action])}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={id + "reason"}>{gt("Reason")}</Label>
                <Select
                  value={draft.reason}
                  onValueChange={(value) => {
                    if (value) setDraft({ ...draft, reason: value });
                  }}
                >
                  <SelectTrigger id={id + "reason"}>{m(reasons[draft.reason])}</SelectTrigger>
                  <SelectPopup>
                    {reasonOptions.map((reason) => (
                      <SelectItem key={reason} value={reason}>
                        {m(reasons[reason])}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
          </fieldset>
          {result && (
            <div role="status" className="space-y-1 text-sm">
              <p>
                {gt("{count, plural, one {# matching thread} other {# matching threads}}", {
                  count: result.total,
                })}
              </p>
              <ul className="text-xs text-muted-foreground">
                {result.matches.slice(0, 5).map((match) => (
                  <li key={match.threadId}>
                    {match.from} · {match.subject || gt("(No subject)")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {gt("Cancel")}
          </Button>
          <Button
            variant="outline"
            disabled={preview.disabled || !rule}
            onClick={async () => {
              if (!rule) return;
              const response = await preview.run({ rule });
              if (response) setSample({ draft, result: response.value });
            }}
          >
            {gt("Dry run")}
          </Button>
          <Button
            disabled={disabled || !rule}
            onClick={() => {
              if (rule) void onSave(rule);
            }}
          >
            {gt("Save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function MailRules({
  environmentId,
  rules,
}: {
  environmentId: EnvironmentId;
  rules: readonly MailRule[];
}) {
  const gt = useGT();
  const m = useMessages();
  const searchable = useSearchableSetting();
  const save = useMailCommand(
    environmentId,
    mailEnvironment.updateSettings,
    gt("Could not save rules"),
  );
  const [editing, setEditing] = useState<{ rule: MailRule; adding: boolean } | null>(null);
  return (
    <SettingsSection
      {...searchable("mail-rules")}
      headerAction={
        <Button
          size="sm"
          variant="outline"
          disabled={save.disabled}
          onClick={() =>
            setEditing({
              adding: true,
              rule: {
                // @effect-diagnostics-next-line cryptoRandomUUID:off -- Drafts are created in a browser event. Plain HTTP LAN origins need the UUID fallback.
                id: crypto.randomUUID?.() ?? randomUUID(),
                enabled: true,
                match: {},
                action: "settle",
                reason: "fyi",
              },
            })
          }
        >
          {gt("Add rule")}
        </Button>
      }
    >
      {rules.length === 0 && <SettingsRow title={gt("No rules")} />}
      {rules.map((rule) => (
        <SettingsRow
          key={rule.id}
          title={matchFields
            .flatMap(([key, label]) =>
              rule.match[key]
                ? [gt("{field}: {value}", { field: m(label), value: rule.match[key] })]
                : [],
            )
            .join(" · ")}
          description={gt("{action} · {reason}", {
            action: m(actions[rule.action]),
            reason: m(reasons[rule.reason]),
          })}
          control={
            <div className="flex items-center gap-2">
              <Switch
                aria-label={gt("Enable rule")}
                checked={rule.enabled}
                disabled={save.disabled}
                onCheckedChange={(enabled) =>
                  void save.run({
                    rules: rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r)),
                  })
                }
              />
              <Button
                variant="outline"
                size="xs"
                disabled={save.disabled}
                onClick={() => setEditing({ adding: false, rule })}
              >
                {gt("Edit")}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={save.disabled}
                onClick={() => void save.run({ rules: rules.filter((r) => r.id !== rule.id) })}
              >
                {gt("Delete")}
              </Button>
            </div>
          }
        />
      ))}
      {editing && (
        <RuleDialog
          environmentId={environmentId}
          initial={editing.rule}
          adding={editing.adding}
          disabled={save.disabled}
          onClose={() => setEditing(null)}
          onSave={async (rule) => {
            if (
              await save.run({
                rules: editing.adding
                  ? [...rules, rule]
                  : rules.map((r) => (r.id === rule.id ? rule : r)),
              })
            )
              setEditing(null);
          }}
        />
      )}
    </SettingsSection>
  );
}
