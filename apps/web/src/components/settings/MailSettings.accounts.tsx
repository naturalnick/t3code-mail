import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MailAccount } from "@t3tools/contracts";
import { msg, useGT, useLocale, useMessages } from "gt-react";
import { useId, useState, type FormEvent } from "react";
import { requestConfirmDialog } from "../../confirmDialog";
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
import { Input, type InputProps } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { useMailCommand } from "./MailSettings.commands";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const accountStatuses = {
  connecting: msg("Connecting"),
  syncing: msg("Syncing"),
  idle: msg("Connected"),
  paused: msg("Paused"),
  auth_failed: msg("Authentication failed"),
  error: msg("Error"),
  offline: msg("Offline"),
} satisfies Record<MailAccount["status"], string>;

function AccountField({ label, ...props }: InputProps & { label: string }) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  );
}

function AccountDialog({
  environmentId,
  account,
  onClose,
}: {
  environmentId: EnvironmentId;
  account: MailAccount | null;
  onClose: () => void;
}) {
  const gt = useGT();
  const formId = useId();
  const add = useMailCommand(
    environmentId,
    mailEnvironment.addAccount,
    gt("Could not add account"),
  );
  const update = useMailCommand(
    environmentId,
    mailEnvironment.updateAccount,
    gt("Could not update account"),
  );
  const command = account ? update : add;
  const [custom, setCustom] = useState(false);
  const [imapTls, setImapTls] = useState(true);
  const [smtpTls, setSmtpTls] = useState(true);
  const reauth = account?.status === "auth_failed";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => String(form.get(name) ?? "");
    const appPassword = field("password");
    const displayName = field("displayName").trim();
    const email = field("email").trim();
    const result = account
      ? await update.run({
          accountId: account.id,
          displayName,
          ...(appPassword ? { appPassword } : {}),
        })
      : await add.run({
          email,
          appPassword,
          ...(displayName ? { displayName } : {}),
          ...(custom
            ? {
                connection: {
                  imapHost: field("imapHost").trim(),
                  imapPort: Number(field("imapPort")),
                  imapTls,
                  smtpHost: field("smtpHost").trim(),
                  smtpPort: Number(field("smtpPort")),
                  smtpTls,
                  username: field("username").trim() || email,
                },
              }
            : {}),
        });
    if (result) onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.pending) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {reauth
              ? gt("Reconnect {email}", { email: account.email })
              : account
                ? gt("Edit account")
                : gt("Add account")}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} onSubmit={(event) => void submit(event)}>
            <fieldset disabled={command.disabled} className="grid gap-4">
              <AccountField
                label={gt("Email address")}
                type="email"
                autoComplete="username"
                name="email"
                defaultValue={account?.email}
                readOnly={!!account}
                required
              />
              <AccountField
                label={gt("Display name (optional)")}
                name="displayName"
                defaultValue={account?.displayName}
              />
              <div className="grid gap-1.5">
                <AccountField
                  label={
                    account && !reauth ? gt("New app password (optional)") : gt("App password")
                  }
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required={!account || reauth}
                />
                {(!account || account.provider === "gmail") && (
                  <a
                    className="w-fit text-xs text-muted-foreground underline"
                    href="https://myaccount.google.com/apppasswords"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {gt("Create a Gmail app password")}
                  </a>
                )}
              </div>
              {!account && (
                <>
                  <details open={custom} onToggle={(event) => setCustom(event.currentTarget.open)}>
                    <summary className="cursor-pointer text-sm">{gt("Other provider")}</summary>
                    {custom && (
                      <div className="mt-3 grid gap-3">
                        <AccountField
                          label={gt("Username")}
                          name="username"
                          placeholder={gt("Same as email address")}
                        />
                        <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
                          <AccountField label={gt("IMAP host")} name="imapHost" required />
                          <AccountField
                            label={gt("IMAP port")}
                            name="imapPort"
                            type="number"
                            min={1}
                            max={65535}
                            defaultValue={993}
                            required
                          />
                        </div>
                        <Label>
                          <Switch checked={imapTls} onCheckedChange={setImapTls} />
                          {gt("IMAP implicit TLS")}
                        </Label>
                        <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
                          <AccountField label={gt("SMTP host")} name="smtpHost" required />
                          <AccountField
                            label={gt("SMTP port")}
                            name="smtpPort"
                            type="number"
                            min={1}
                            max={65535}
                            defaultValue={465}
                            required
                          />
                        </div>
                        <Label>
                          <Switch checked={smtpTls} onCheckedChange={setSmtpTls} />
                          {gt("SMTP implicit TLS")}
                        </Label>
                      </div>
                    )}
                  </details>
                  <p className="text-xs text-muted-foreground">
                    {gt(
                      "Mail stays on the computer hosting Mail, except what is sent to your model provider.",
                    )}
                  </p>
                </>
              )}
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={command.pending} onClick={onClose}>
            {gt("Cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={command.disabled}>
            {account ? gt("Save") : gt("Add account")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function MailAccounts({
  environmentId,
  accounts,
}: {
  environmentId: EnvironmentId;
  accounts: readonly MailAccount[];
}) {
  const gt = useGT();
  const messages = useMessages();
  const locale = useLocale();
  const searchable = useSearchableSetting();
  const [editing, setEditing] = useState<MailAccount | "add" | null>(null);
  const remove = useMailCommand(
    environmentId,
    mailEnvironment.removeAccount,
    gt("Could not remove account"),
  );
  const sync = useMailCommand(environmentId, mailEnvironment.syncNow, gt("Could not sync account"));
  const addAllowed = useAtomValue(mailEnvironment.addAccount.permissionAtom(environmentId));
  const updateAllowed = useAtomValue(mailEnvironment.updateAccount.permissionAtom(environmentId));
  const date = (iso: string) => new Date(iso).toLocaleString(locale);
  async function removeAccount(account: MailAccount) {
    const message = gt(
      "Remove {email}, its saved app password, and synced mail from the host? T3 chat histories, including mail chats, are kept.",
      {
        email: account.email,
      },
    );
    if (
      (await requestConfirmDialog(message, { variant: "destructive" })) ??
      window.confirm(message)
    )
      await remove.run({ accountId: account.id });
  }
  return (
    <SettingsSection
      {...searchable("mail-accounts")}
      headerAction={
        <Button
          size="sm"
          variant="outline"
          disabled={!addAllowed}
          onClick={() => setEditing("add")}
        >
          {gt("Add account")}
        </Button>
      }
    >
      {accounts.length === 0 && <SettingsRow title={gt("No connected accounts")} />}
      {accounts.map((account) => (
        <SettingsRow
          key={account.id}
          title={account.email}
          description={[
            account.displayName !== account.email && account.displayName,
            account.provider === "gmail" ? gt("Gmail") : gt("IMAP"),
            messages(accountStatuses[account.status]),
            account.lastSyncAt
              ? gt("Last synced {time}", { time: date(account.lastSyncAt) })
              : gt("Never synced"),
          ]
            .filter(Boolean)
            .join(" · ")}
          control={
            <div className="flex flex-wrap gap-1">
              <Button
                size="xs"
                variant="outline"
                disabled={sync.disabled}
                onClick={() => void sync.run({ accountId: account.id })}
              >
                {gt("Sync now")}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!updateAllowed}
                onClick={() => setEditing(account)}
              >
                {account.status === "auth_failed" ? gt("Re-enter app password") : gt("Edit")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={remove.disabled}
                onClick={() => void removeAccount(account)}
              >
                {gt("Remove")}
              </Button>
            </div>
          }
        >
          {account.statusDetail && (
            <p className="text-xs text-muted-foreground">{account.statusDetail}</p>
          )}
          {account.backfillPausedUntil && (
            <p className="text-xs text-muted-foreground">
              {gt("Older mail sync paused until {time}. New mail still syncs.", {
                time: date(account.backfillPausedUntil),
              })}
            </p>
          )}
          {account.credentialStore === "file" && account.status !== "error" && (
            <p className="text-xs text-muted-foreground">
              {gt("App password stored in a local file.")}
            </p>
          )}
        </SettingsRow>
      ))}
      {editing && (
        <AccountDialog
          environmentId={environmentId}
          account={editing === "add" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsSection>
  );
}
