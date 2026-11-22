import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MailThreadId } from "@t3tools/contracts";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";

import { MailNewEmail } from "../components/mail/MailNewEmail";
import { MailPage } from "../components/mail/MailPage";
import { randomUUID } from "../lib/utils";
import { mailEnvironment, useMailEnvironmentId } from "../state/mail";
import { useEnvironmentQuery } from "../state/query";

interface NewEmailSearch {
  /** Each New email gets its own id, so it starts blank and a retried save can't duplicate it. */
  readonly email?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function NewEmailPage() {
  const environmentId = useMailEnvironmentId();
  const requested = Route.useSearch({ select: (search) => search.email });
  const [fallback] = useState(randomUUID);
  const composeId = requested ?? fallback;
  return environmentId ? (
    <NewEmail key={environmentId + composeId} environmentId={environmentId} composeId={composeId} />
  ) : (
    <MailPage>{null}</MailPage>
  );
}

/** Stays on this page after the first save, following the saved email like any other. */
function NewEmail({
  environmentId,
  composeId,
}: {
  environmentId: EnvironmentId;
  composeId: string;
}) {
  const [threadId, setThreadId] = useState<MailThreadId | null>(null);
  const view = useAtomValue(mailEnvironment.view(environmentId));
  const query = useEnvironmentQuery(
    threadId ? mailEnvironment.thread({ environmentId, input: { threadId } }) : null,
  );
  const thread = threadId ? (view?.threads.get(threadId) ?? query.data?.thread ?? null) : null;
  // Reopening this page's link after a save shows the saved email. Checked once, when mail
  // first loads, so this page's own first save never redirects it mid-typing.
  const [earlier, setEarlier] = useState<string | null | undefined>(undefined);
  if (earlier === undefined && view !== null) {
    setEarlier([...view.threads.keys()].find((id) => id.endsWith(`:n:${composeId}`)) ?? null);
  }
  if (earlier) {
    return <Navigate to="/mail/$mailThreadId" params={{ mailThreadId: earlier }} replace />;
  }
  return (
    <MailNewEmail
      environmentId={environmentId}
      thread={thread}
      detail={threadId ? query.data : null}
      composeId={composeId}
      onCreated={(draft) => setThreadId(draft.threadId)}
      // Opening the chat moves to the email's own page, which holds the chat.
      chatOpen={false}
      onChatOpenChange={() => {}}
    />
  );
}

export const Route = createFileRoute("/_chat/mail/new")({
  validateSearch: (raw: Record<string, unknown>): NewEmailSearch =>
    typeof raw.email === "string" && UUID.test(raw.email) ? { email: raw.email } : {},
  component: NewEmailPage,
});
