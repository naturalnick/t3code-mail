import { MailThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { MailThreadView } from "../components/mail/MailThreadView";
import { MailPage } from "../components/mail/MailPage";
import { useMailEnvironmentId } from "../state/mail";

function ThreadPage() {
  const environmentId = useMailEnvironmentId();
  const { mailThreadId } = Route.useParams();
  return (
    <MailPage>
      {environmentId && (
        <MailThreadView
          key={environmentId + mailThreadId}
          environmentId={environmentId}
          threadId={MailThreadId.make(mailThreadId)}
        />
      )}
    </MailPage>
  );
}

export const Route = createFileRoute("/_chat/mail/$mailThreadId")({ component: ThreadPage });
