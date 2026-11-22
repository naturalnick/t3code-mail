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
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
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
const actionOptions = ["settle", "keep", "never_show"] as const;

/** A rule's scope in a few words, for lists and the email details. */
export function useRuleSummary() {
  const gt = useGT();
  const m = useMessages();
  return (rule: MailRule) => {
    const scope = matchFields
      .flatMap(([key, label]) =>
        rule.match[key]
          ? [gt("{field}: {value}", { field: m(label), value: rule.match[key] })]
          : [],
      )
      .join(" · ");
    return { scope: scope || gt("Any email"), action: m(actions[rule.action]) };
  };
}

export function newRule(patch: Partial<MailRule> = {}): MailRule {
  return {
    // @effect-diagnostics-next-line cryptoRandomUUID:off -- Drafts are created in a browser event. Plain HTTP LAN origins need the UUID fallback.
    id: crypto.randomUUID?.() ?? randomUUID(),
    enabled: true,
    match: {},
    action: "settle",
    reason: "fyi",
    ...patch,
  };
}

/** Saves one rule into the environment's rule list, adding it or replacing it by id. */
export function useSaveRule(environmentId: EnvironmentId) {
  const gt = useGT();
  const save = useMailCommand(
    environmentId,
    mailEnvironment.updateSettings,
    gt("Could not save rules"),
  );
  return {
    disabled: save.disabled,
    run: async (rules: readonly MailRule[], rule: MailRule) =>
      Boolean(
        await save.run({
          rules: rules.some((r) => r.id === rule.id)
            ? rules.map((r) => (r.id === rule.id ? rule : r))
            : [...rules, rule],
        }),
      ),
  };
}

export function RuleDialog({
  environmentId,
  initial,
  title,
  saveLabel,
  disabled,
  onSave,
  onClose,
}: {
  environmentId: EnvironmentId;
  initial: MailRule;
  title: string;
  saveLabel?: string;
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
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={disabled} className="grid gap-3">
            <legend className="mb-2 text-xs text-muted-foreground">
              {gt("Fill in at least one field. Everything you fill in must match.")}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
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
            </div>
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
            </div>
            {draft.action === "never_show" ? null : (
              <div className="grid gap-1.5">
                <Label htmlFor={id + "when"}>{gt("Only when")}</Label>
                <Textarea
                  id={id + "when"}
                  rows={2}
                  maxLength={300}
                  placeholder={gt("Shipping updates. Keep delivery confirmations.")}
                  value={draft.when ?? ""}
                  onChange={(event) => setDraft({ ...draft, when: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {gt("The AI checks this on each email.")}
                </p>
              </div>
            )}
            {draft.action === "settle" ? (
              <label className="flex cursor-pointer items-center gap-2.5 text-sm has-data-disabled:cursor-default">
                <Checkbox
                  checked={draft.sensitive === true}
                  onCheckedChange={(checked) => setDraft({ ...draft, sensitive: checked === true })}
                />
                {gt("Also settle money, security and legal email")}
              </label>
            ) : null}
          </fieldset>
          {result && (
            <div role="status" className="space-y-1 text-sm">
              <p>
                {rule?.when
                  ? gt(
                      "{count, plural, one {# email in scope. The AI decides which match.} other {# emails in scope. The AI decides which match.}}",
                      { count: result.total },
                    )
                  : gt("{count, plural, one {# matching thread} other {# matching threads}}", {
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
            {saveLabel ?? gt("Save")}
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
  const searchable = useSearchableSetting();
  const summary = useRuleSummary();
  const save = useMailCommand(
    environmentId,
    mailEnvironment.updateSettings,
    gt("Could not save rules"),
  );
  const saveRule = useSaveRule(environmentId);
  const [editing, setEditing] = useState<{ rule: MailRule; adding: boolean } | null>(null);
  return (
    <SettingsSection
      {...searchable("mail-rules")}
      headerAction={
        <Button
          size="sm"
          variant="outline"
          disabled={save.disabled}
          onClick={() => setEditing({ adding: true, rule: newRule() })}
        >
          {gt("Add rule")}
        </Button>
      }
    >
      {rules.length === 0 && <SettingsRow title={gt("No rules")} />}
      {rules.map((rule) => {
        const { scope, action } = summary(rule);
        return (
          <SettingsRow
            key={rule.id}
            title={scope}
            description={
              rule.when ? gt("{action} when: {when}", { action, when: rule.when }) : action
            }
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
        );
      })}
      {editing && (
        <RuleDialog
          environmentId={environmentId}
          initial={editing.rule}
          title={editing.adding ? gt("Add rule") : gt("Edit rule")}
          disabled={saveRule.disabled}
          onClose={() => setEditing(null)}
          onSave={async (rule) => {
            if (await saveRule.run(rules, rule)) setEditing(null);
          }}
        />
      )}
    </SettingsSection>
  );
}
