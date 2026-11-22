import { createFileRoute } from "@tanstack/react-router";

import { MailSettings } from "../components/settings/MailSettings";

export const Route = createFileRoute("/_chat/settings/mail")({
  component: MailSettings,
});
