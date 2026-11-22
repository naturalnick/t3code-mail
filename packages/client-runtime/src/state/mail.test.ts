import { MailAccountId, MailThreadId, type MailThreadRow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupMailThreads } from "./mail.ts";

const row = (id: string, patch: Partial<MailThreadRow>): MailThreadRow => ({
  id: MailThreadId.make(id),
  accountId: MailAccountId.make("acct"),
  subject: id,
  from: { name: "", address: "sam@example.org" },
  suggestedAction: null,
  lastMessageAt: "2026-11-02T09:00:00.000Z",
  lastOutgoingAt: null,
  messageCount: 1,
  unread: false,
  state: "active",
  stateAt: "2026-11-02T09:00:00.000Z",
  pinnedAt: null,
  workingReason: null,
  settledReason: null,
  settledBy: null,
  snoozedUntil: null,
  snoozeOnReply: false,
  suggestion: null,
  category: null,
  guardrail: null,
  nudge: null,
  hasDraft: false,
  chatThreadId: null,
  injectionWarning: false,
  triagePending: false,
  why: null,
  decidedBy: null,
  ruleId: null,
  ...patch,
});

describe("groupMailThreads", () => {
  it("keeps a new email in Drafts only, and lists a reply draft in both places", () => {
    const sections = groupMailThreads([
      row("new", { messageCount: 0, state: "working", workingReason: "drafting", hasDraft: true }),
      row("reply", { hasDraft: true }),
      row("plain", {}),
    ]);
    expect(sections.drafts.map((thread) => thread.id)).toEqual(["reply", "new"]);
    expect(sections.working).toEqual([]);
    expect(sections.active.map((thread) => thread.id)).toEqual(["reply", "plain"]);
  });
});
