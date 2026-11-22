import { MailThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import type { ComposeMode } from "../components/mail/mailCompose.logic";
import { MailThreadView } from "../components/mail/MailThreadView";
import { MailPage } from "../components/mail/MailPage";
import { useMailEnvironmentId } from "../state/mail";

interface MailThreadSearch {
  readonly chat?: true;
  readonly rule?: true | string;
  readonly compose?: ComposeMode;
}

function ThreadPage() {
  const environmentId = useMailEnvironmentId();
  const { mailThreadId } = Route.useParams();
  const chatOpen = Route.useSearch({ select: (search) => search.chat === true });
  const ruleOpen = Route.useSearch({ select: (search) => search.rule ?? false });
  const compose = Route.useSearch({ select: (search) => search.compose ?? null });
  const navigate = Route.useNavigate();
  return environmentId ? (
    <MailThreadView
      key={environmentId + mailThreadId}
      environmentId={environmentId}
      threadId={MailThreadId.make(mailThreadId)}
      chatOpen={chatOpen}
      onChatOpenChange={(open) =>
        void navigate({ search: open ? { chat: true } : {}, replace: true })
      }
      ruleOpen={ruleOpen}
      onRuleOpenChange={(open) =>
        void navigate({
          search: ({ rule: _rule, ...rest }) => (open ? { ...rest, rule: open } : rest),
          replace: true,
        })
      }
      requestedCompose={compose}
      onComposeHandled={() =>
        void navigate({ search: chatOpen ? { chat: true } : {}, replace: true })
      }
    />
  ) : (
    <MailPage>{null}</MailPage>
  );
}

export const Route = createFileRoute("/_chat/mail/$mailThreadId")({
  validateSearch: (raw: Record<string, unknown>): MailThreadSearch => ({
    ...(raw.rule === true || raw.rule === "true"
      ? { rule: true as const }
      : typeof raw.rule === "string" && raw.rule
        ? { rule: raw.rule }
        : {}),
    ...(raw.chat === true || raw.chat === "true" ? { chat: true as const } : {}),
    ...(raw.compose === "reply" || raw.compose === "replyAll" || raw.compose === "forward"
      ? { compose: raw.compose }
      : {}),
  }),
  component: ThreadPage,
});
