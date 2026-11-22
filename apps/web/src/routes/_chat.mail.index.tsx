import { createFileRoute } from "@tanstack/react-router";
import { MailHome } from "../components/mail/MailHome";

export const Route = createFileRoute("/_chat/mail/")({ component: MailHome });
