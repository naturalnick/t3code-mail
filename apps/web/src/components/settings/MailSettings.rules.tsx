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
    return scope || gt("Any email");
  };
}

export function newRule(patch: Partial<MailRule> = {}): MailRule {
  return {
    // @effect-diagnostics-next-line cryptoRandomUUID:off -- Drafts are created in a browser event. Plain HTTP LAN origins need the UUID fallback.
    id: crypto.randomUUID?.() ?? randomUUID(),
    enabled: true,
    match: {},
    reason: "fyi",
    ...patch,
  };
}

export function useSaveRule(environmentId: EnvironmentId) {
  const gt = useGT();
  const command = useMailCommand(
    environmentId,
    mailEnvironment.saveRule,
    gt("Could not save rules"),
  );
  return {
    ...command,
    save: (rule: MailRule, editing: boolean) =>
      command.run({
        ...(editing ? { ruleId: rule.id } : { reason: rule.reason }),
        match: rule.match,
        when: rule.when ?? "",
      }),
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
  children,
  environmentId,
  rules,
}: {
  environmentId: EnvironmentId;
  rules: readonly MailRule[];
  children: React.ReactNode;
}) {
  const gt = useGT();
  const searchable = useSearchableSetting();
  const summary = useRuleSummary();
  const saveRule = useSaveRule(environmentId);
  const [editing, setEditing] = useState<{ rule: MailRule; adding: boolean } | null>(null);
  return (
    <SettingsSection
      {...searchable("mail-rules")}
      headerAction={
        <Button
          size="sm"
          variant="outline"
          disabled={saveRule.disabled}
          onClick={() => setEditing({ adding: true, rule: newRule() })}
        >
          {gt("Add rule")}
        </Button>
      }
    >
      {children}
      {rules.map((rule) => {
        return (
          <SettingsRow
            key={rule.id}
            title={summary(rule)}
            description={[
              rule.when ? gt("Only when: {when}", { when: rule.when }) : null,
              rule.addedBy ? gt("Added by {agent}", { agent: rule.addedBy }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            control={
              <div className="flex items-center gap-2">
                <Switch
                  aria-label={gt("Enable rule")}
                  checked={rule.enabled}
                  disabled={saveRule.disabled}
                  onCheckedChange={(enabled) => void saveRule.run({ ruleId: rule.id, enabled })}
                />
                <Button
                  variant="outline"
                  size="xs"
                  disabled={saveRule.disabled}
                  onClick={() => setEditing({ adding: false, rule })}
                >
                  {gt("Edit")}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={saveRule.disabled}
                  onClick={() => void saveRule.run({ ruleId: rule.id, delete: true })}
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
            if (await saveRule.save(rule, !editing.adding)) setEditing(null);
          }}
        />
      )}
    </SettingsSection>
  );
}
