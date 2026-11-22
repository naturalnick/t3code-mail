import { describe, expect, it } from "vite-plus/test";

import { composeOutgoing } from "./mailCompose.ts";

const source = {
  from: { name: "Ellen Velline", address: "ellen@example.org" },
  to: [{ name: "Nick", address: "nick@example.com" }],
  cc: [{ name: "", address: "sam@example.org" }],
  date: "2026-11-05T21:46:00.000Z",
  subject: "Survey",
  text: "Can you fill this out?\n\nThanks",
  html: '<html><head><style>p{}</style></head><body><style>div{color:red}</style><p onclick="x()">Can you <img src="cid:logo"> <a href="javascript:x()">go</a></p><script>x()</script></body></html>',
  inlineImages: {
    logo: "data:image/png;base64,aGk=",
    unused: "data:image/png;base64,aGk=",
  },
};

describe("composeOutgoing", () => {
  it("quotes the answered message under the reply in text and HTML", () => {
    const result = composeOutgoing({
      mode: "reply",
      body: "Done.\n",
      source,
      files: [],
      timeZone: "UTC",
    });
    expect(result.text).toBe(
      [
        "Done.",
        "",
        "On Thu, Nov 5, 2026 at 9:46 PM, Ellen Velline <ellen@example.org> wrote:",
        "",
        "> Can you fill this out?",
        ">",
        "> Thanks",
      ].join("\n"),
    );
    expect(result.html).toContain('<blockquote class="gmail_quote"');
    expect(result.html).not.toMatch(/<script|<head|<style|onclick|javascript:/);
    // Only the inline image the quoted HTML shows travels with it.
    expect(result.attachments.map((file) => file.cid)).toEqual(["logo"]);
  });

  it("forwards with the original's headers and files", () => {
    const pdf = { filename: "a.pdf", contentType: "application/pdf", content: Buffer.from("x") };
    const logo = { filename: "logo.png", contentType: "image/png", content: Buffer.from("y") };
    const result = composeOutgoing({
      mode: "forward",
      body: "",
      source,
      files: [{ ...logo, cid: "logo" }, pdf],
      timeZone: "UTC",
    });
    expect(result.text).toContain(
      [
        "---------- Forwarded message ---------",
        "From: Ellen Velline <ellen@example.org>",
        "Date: Thu, Nov 5, 2026 at 9:46 PM",
        "Subject: Survey",
        "To: Nick <nick@example.com>",
        "Cc: sam@example.org",
      ].join("\n"),
    );
    // The inline logo the server fetched is sent once, not again from the reader's cache.
    expect(result.attachments.map((file) => file.filename)).toEqual(["logo.png", "a.pdf"]);
  });

  it("sends only the typed text when there is nothing to quote", () => {
    expect(composeOutgoing({ mode: "reply", body: "Hi", source: null, files: [] })).toEqual({
      text: "Hi",
      html: null,
      attachments: [],
    });
  });
});
