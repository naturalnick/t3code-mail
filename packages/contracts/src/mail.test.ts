import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { MailDraft, MailMessage } from "./mail.ts";

const decodeMessage = Schema.decodeSync(MailMessage);
const decodeDraft = Schema.decodeSync(MailDraft);

describe("mail contracts", () => {
  it("reads messages and drafts from a server that predates reply targets", () => {
    const message = decodeMessage({
      id: "1",
      from: { name: "Ellen", address: "ellen@example.org" },
      to: [],
      cc: [],
      date: "2026-11-05T21:46:00.000Z",
      subject: "Survey",
      text: null,
      fullText: null,
      attachments: [],
      outgoing: false,
      unread: false,
    });
    expect(message.replyTo).toEqual([]);
    const draft = decodeDraft({
      id: "draft-1",
      threadId: "thread-1",
      accountId: "account-1",
      to: ["ellen@example.org"],
      cc: [],
      subject: "Re: Survey",
      body: "Done.",
      origin: "user",
      status: "draft",
      error: null,
      revision: 1,
      updatedAt: "2026-11-05T21:46:00.000Z",
      sentAt: null,
    });
    expect(draft).toMatchObject({ mode: "reply", targetMessageId: null });
  });
});
