import { createFileRoute } from "@tanstack/react-router";
import { MailHome } from "../components/mail/MailHome";

interface MailHomeSearch {
  readonly chat?: true;
}

function HomePage() {
  const chatOpen = Route.useSearch({ select: (search) => search.chat === true });
  const navigate = Route.useNavigate();
  return (
    <MailHome
      chatOpen={chatOpen}
      onChatOpenChange={(open) =>
        void navigate({ search: open ? { chat: true } : {}, replace: true })
      }
    />
  );
}

export const Route = createFileRoute("/_chat/mail/")({
  validateSearch: (raw: Record<string, unknown>): MailHomeSearch =>
    raw.chat === true || raw.chat === "true" ? { chat: true } : {},
  component: HomePage,
});
