import type { EnvironmentId, MailStatus } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import {
  mailEnvironment,
  useMailEnvironmentId,
  useMailSections,
  useMailStatus,
} from "../../state/mail";
import { useEnvironmentQuery } from "../../state/query";
import { useMailCommand } from "../settings/MailSettings.commands";
import { Button } from "../ui/button";
import { MailPage } from "./MailPage";
import { MailDecider } from "./MailDecider";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { actionLabel, senderName } from "./mailPresentation";
import { useMailActions } from "./useMailActions";

function AutomaticActions({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const resolve = useMessages();
  const [before, setBefore] = useState<number[]>([]);
  const cursor = before.at(-1);
  const query = useEnvironmentQuery(
    mailEnvironment.actions({
      environmentId,
      input: { automatic: true, limit: 20, ...(cursor === undefined ? {} : { beforeId: cursor }) },
    }),
  );
  const actions = useMailActions(environmentId);
  const entries = query.data?.actions ?? [];
  return (
    <section className="grid min-w-0 grid-cols-1 gap-2 pt-2">
      {query.error && <p role="alert">{query.error}</p>}
      {query.data && entries.length === 0 && (
        <p className="text-sm text-muted-foreground">{gt("No automatic actions yet.")}</p>
      )}
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-center gap-3 border-b py-2 text-sm">
          <div className="min-w-0 flex-1">
            {entry.threadId ? (
              <Link
                className="block truncate font-medium hover:underline"
                to="/mail/$mailThreadId"
                params={{ mailThreadId: entry.threadId }}
              >
                {entry.subject || entry.from}
              </Link>
            ) : (
              <span className="block truncate font-medium">{entry.subject || entry.from}</span>
            )}
            <span className="text-xs text-muted-foreground">{actionLabel(entry, resolve)}</span>
          </div>
          {entry.undoneAt
            ? gt("Undone")
            : entry.undoable && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={actions.disabled}
                  onClick={() => void actions.undo([entry.id])}
                >
                  {entry.reason === "sign_in_code" ? gt("Restore") : gt("Undo")}
                </Button>
              )}
        </div>
      ))}
      <div className="flex gap-2">
        {before.length > 0 && (
          <Button variant="ghost" size="xs" onClick={() => setBefore(before.slice(0, -1))}>
            {gt("Previous")}
          </Button>
        )}
        {query.data?.hasMore && entries.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setBefore([...before, entries[entries.length - 1]!.id])}
          >
            {gt("Next")}
          </Button>
        )}
      </div>
    </section>
  );
}

/** Mail from before the account was connected; sending it to AI is the user's call. */
function ExistingInbox({
  environmentId,
  status,
}: {
  environmentId: EnvironmentId;
  status: MailStatus;
}) {
  const gt = useGT();
  const review = useMailCommand(
    environmentId,
    mailEnvironment.reviewExisting,
    gt("Could not change the review"),
  );
  const reviewing = status.reviewing > 0;
  return (
    <section className="grid min-w-0 grid-cols-1 justify-items-start gap-2">
      <h2 className="text-sm font-medium">{gt("Existing inbox")}</h2>
      <p className="text-sm text-muted-foreground">
        {reviewing
          ? gt(
              "{count, plural, one {AI is sorting # email from before you connected.} other {AI is sorting # emails from before you connected.}}",
              { count: status.reviewing },
            )
          : gt(
              "{count, plural, one {# email from before you connected hasn't been sorted. AI sorts new mail only.} other {# emails from before you connected haven't been sorted. AI sorts new mail only.}}",
              { count: status.unreviewed },
            )}
      </p>
      <Button
        size="sm"
        variant={reviewing ? "outline" : "default"}
        disabled={review.disabled || (!reviewing && status.settings.defaultModelSelection === null)}
        // The count on the button is what the user agreed to; mail held later waits.
        onClick={() =>
          void review.run(
            reviewing ? { review: false } : { review: true, limit: status.unreviewed },
          )
        }
      >
        {reviewing
          ? gt("Stop")
          : gt("{count, plural, one {Review # email with AI} other {Review # emails with AI}}", {
              count: status.unreviewed,
            })}
      </Button>
    </section>
  );
}

function Inbox({ environmentId, status }: { environmentId: EnvironmentId; status: MailStatus }) {
  const gt = useGT();
  const sections = useMailSections(environmentId);
  const actions = useMailActions(environmentId);
  const dismiss = useMailCommand(
    environmentId,
    mailEnvironment.dismissRecap,
    gt("Could not dismiss recap"),
  );
  // Unticked suggestions stay in Active; nothing else happens to them.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const recap = status.recap;
  const proposals = sections?.proposals.slice(0, 50) ?? [];
  const chosen = proposals.filter((t) => !skipped.has(t.id));
  const needsSetup = status.accounts.length === 0 || status.settings.defaultModelSelection === null;
  const reauth = status.accounts.filter((a) => a.status === "auth_failed");
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{gt("Mail review")}</h1>
        <Button render={<Link to="/settings/mail" />} variant="ghost" size="sm">
          {gt("Mail settings")}
        </Button>
      </div>
      {needsSetup && (
        <section className="grid min-w-0 grid-cols-1 justify-items-start gap-2">
          <p className="text-sm">
            {status.accounts.length === 0
              ? gt("Connect an account to start syncing mail.")
              : gt("Choose a mail model to start triage.")}
          </p>
          <Button render={<Link to="/settings/mail" />} size="sm">
            {status.accounts.length === 0 ? gt("Add account") : gt("Choose model")}
          </Button>
        </section>
      )}
      {reauth.map((account) => (
        <Link key={account.id} className="text-sm wrap-anywhere underline" to="/settings/mail">
          {gt("Reconnect {email}", { email: account.email })}
        </Link>
      ))}
      {status.accounts.length > 0 && (status.unreviewed > 0 || status.reviewing > 0) ? (
        <ExistingInbox environmentId={environmentId} status={status} />
      ) : null}
      {recap && status.accounts.length > 0 && (
        <section className="grid min-w-0 grid-cols-1 gap-1">
          <div className="flex flex-wrap items-center justify-between">
            <h2 className="text-sm font-medium">{gt("Daily recap")}</h2>
            <Button
              size="xs"
              variant="ghost"
              disabled={dismiss.disabled}
              onClick={() => void dismiss.run({ date: recap.date })}
            >
              {gt("Dismiss")}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {gt("{arrived} arrived · {active} need you", {
              arrived: recap.arrived,
              active: recap.needsYou,
            })}
          </p>
          {recap.settled.length > 0 ? (
            <ul aria-label={gt("Settled for you")} className="mt-1 grid min-w-0 grid-cols-1">
              {recap.settled.map((item) => (
                <li key={item.actionId} className="flex items-center gap-3 border-b py-2 text-sm">
                  <MailDecider
                    environmentId={environmentId}
                    actor={item.actor}
                    decidedBy={item.decidedBy}
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      className="block truncate hover:underline"
                      to="/mail/$mailThreadId"
                      params={{ mailThreadId: item.threadId }}
                    >
                      <span className="font-medium">{item.from}</span> · {item.subject}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {item.why ??
                        (item.actor === "rule" ? gt("Settled by your rule") : gt("Settled by AI"))}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={actions.disabled}
                    // Undo also tells Mail the settle was wrong, so it learns from the answer.
                    onClick={() => void actions.undo([item.actionId])}
                  >
                    {gt("Bring back")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {recap.moreSettled > 0 ? (
            <p className="text-xs text-muted-foreground">
              {gt("{count, plural, one {and # more in Settled} other {and # more in Settled}}", {
                count: recap.moreSettled,
              })}
            </p>
          ) : null}
        </section>
      )}
      {proposals.length > 0 && (
        <section className="grid min-w-0 grid-cols-1 gap-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">{gt("Suggested settles")}</h2>
            <Button
              size="sm"
              variant="outline"
              disabled={actions.disabled || chosen.length === 0}
              onClick={() =>
                void actions.act(
                  chosen.map((t) => t.id),
                  {
                    type: "approve",
                    revisions: Object.fromEntries(
                      chosen.map((t) => [t.id, t.suggestion!.revision]),
                    ),
                  },
                  gt("Settled"),
                )
              }
            >
              {gt("Settle {count}", { count: chosen.length })}
            </Button>
          </div>
          {proposals.map((t) => (
            <div key={t.id} className="flex items-center gap-2 border-b py-1.5 text-sm">
              <Checkbox
                aria-label={gt("Settle {subject}", { subject: t.subject || senderName(t.from) })}
                checked={!skipped.has(t.id)}
                onCheckedChange={(checked) => {
                  const next = new Set(skipped);
                  if (checked) next.delete(t.id);
                  else next.add(t.id);
                  setSkipped(next);
                }}
              />
              <Link
                to="/mail/$mailThreadId"
                params={{ mailThreadId: t.id }}
                className="min-w-0 flex-1 truncate hover:underline"
              >
                {senderName(t.from)} · {t.subject}
              </Link>
            </div>
          ))}
        </section>
      )}
      {status.accounts.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-sm font-medium hover:text-foreground data-panel-open:[&_svg]:rotate-90">
            <ChevronRightIcon className="size-4 transition-transform" aria-hidden />
            {gt("Automatic actions")}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <AutomaticActions environmentId={environmentId} />
          </CollapsiblePanel>
        </Collapsible>
      )}
    </>
  );
}

export function MailHome() {
  const gt = useGT();
  const environmentId = useMailEnvironmentId();
  const status = useMailStatus(environmentId);
  return (
    <MailPage>
      <div className="mx-auto grid w-full min-w-0 grid-cols-1 max-w-3xl gap-6 p-5">
        {environmentId === null ? (
          gt("No connected server has Mail.")
        ) : status === null ? (
          gt("Loading mail…")
        ) : (
          <Inbox key={environmentId} environmentId={environmentId} status={status} />
        )}
      </div>
    </MailPage>
  );
}
