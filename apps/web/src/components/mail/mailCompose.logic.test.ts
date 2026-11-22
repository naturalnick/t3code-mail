import type { MailMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composeRecipients, defaultReplyTarget, hasOtherRecipients } from "./mailCompose.logic";

const me = "nick@example.com";
const message = (patch: Partial<MailMessage>): MailMessage => ({
  id: "1",
  from: { name: "Ellen", address: "ellen@example.org" },
  replyTo: [],
  to: [{ name: "Nick", address: "Nick@Example.com" }],
  cc: [],
  date: "2026-11-05T21:46:00.000Z",
  subject: "Survey",
  text: null,
  fullText: null,
  attachments: [],
  outgoing: false,
  unread: false,
  ...patch,
});

describe("composeRecipients", () => {
  it.each([
    {
      name: "reply goes to the sender",
      mode: "reply" as const,
      input: message({ cc: [{ name: "", address: "sam@example.org" }] }),
      expected: { to: ["ellen@example.org"], cc: [] },
    },
    {
      name: "reply honors Reply-To",
      mode: "reply" as const,
      input: message({ replyTo: [{ name: "Help", address: "help@example.org" }] }),
      expected: { to: ["help@example.org"], cc: [] },
    },
    {
      name: "reply all keeps everyone but you, once",
      mode: "replyAll" as const,
      input: message({
        to: [
          { name: "Nick", address: "NICK@example.com" },
          { name: "", address: "sam@example.org" },
        ],
        cc: [
          { name: "", address: "ellen@example.org" },
          { name: "", address: "lee@example.org" },
        ],
      }),
      expected: { to: ["ellen@example.org"], cc: ["sam@example.org", "lee@example.org"] },
    },
    {
      name: "replying to your own message reaches the people you wrote to",
      mode: "replyAll" as const,
      input: message({
        outgoing: true,
        from: { name: "Nick", address: me },
        to: [{ name: "", address: "b@example.org" }],
        cc: [{ name: "", address: "c@example.org" }],
      }),
      expected: { to: ["b@example.org"], cc: ["c@example.org"] },
    },
    {
      name: "forward starts empty",
      mode: "forward" as const,
      input: message({}),
      expected: { to: [], cc: [] },
    },
  ])("$name", ({ mode, input, expected }) => {
    expect(composeRecipients(mode, input, [me])).toEqual(expected);
  });

  it("offers Reply all only when it reaches someone Reply would not", () => {
    expect(hasOtherRecipients(message({}), [me])).toBe(false);
    expect(
      hasOtherRecipients(message({ cc: [{ name: "", address: "sam@example.org" }] }), [me]),
    ).toBe(true);
  });
});

describe("defaultReplyTarget", () => {
  it("skips your own newer forward", () => {
    const incoming = message({ id: "1" });
    const forward = message({ id: "2", outgoing: true, subject: "Fwd: Survey" });
    expect(defaultReplyTarget([incoming, forward])?.id).toBe("1");
  });
});
