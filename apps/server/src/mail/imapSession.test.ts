// @effect-diagnostics nodeBuiltinImport:off -- imapflow supplies decoded Node streams for each MIME part.
import * as NodeStream from "node:stream";
import { expect, it, vi } from "vite-plus/test";
import { ImapSession } from "./imapSession.ts";

it("reads the HTML alternative and its referenced inline image, leaving attachments and plain-only mail alone", async () => {
  const session = new ImapSession(
    { host: "localhost", port: 1, secure: false, user: "fixture", password: "fixture" },
    { onExists: () => {}, onFlags: () => {}, onExpunge: () => {}, onClose: () => {} },
  );
  using structure = vi
    .spyOn(session.client, "fetchOne")
    .mockResolvedValueOnce({
      seq: 1,
      uid: 3,
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [
          {
            type: "message/rfc822",
            disposition: "attachment",
            childNodes: [{ type: "text/html", part: "1.1" }],
          },
          {
            type: "multipart/alternative",
            childNodes: [
              { type: "text/plain", part: "2.1" },
              { type: "text/html", part: "2.2" },
            ],
          },
          { type: "image/png", part: "3", id: "<logo>", size: 4 },
          { type: "image/png", part: "4", id: "<unused>", size: 50 },
        ],
      },
    })
    .mockResolvedValueOnce({ seq: 2, uid: 4, bodyStructure: { type: "text/plain", part: "1" } });
  const html = '<h1>Résumé</h1><img src="cid:logo">';
  using download = vi
    .spyOn(session.client, "download")
    .mockResolvedValueOnce({ meta: {}, content: NodeStream.Readable.from([Buffer.from(html)]) })
    .mockResolvedValueOnce({ meta: {}, content: NodeStream.Readable.from([Buffer.from("logo")]) });
  expect(await session.fetchFormattedBody(3)).toEqual({
    html,
    inlineImages: { logo: "data:image/png;base64,bG9nbw==" },
  });
  expect(await session.fetchFormattedBody(4)).toBeNull();
  expect(structure).toHaveBeenCalledTimes(2);
  expect(download.mock.calls.map((call) => call[1])).toEqual(["2.2", "3"]);
});

it("uses Gmail label operations for a custom mailbox name and preserves provider flags on readback", async () => {
  const session = new ImapSession(
    { host: "localhost", port: 1, secure: false, user: "fixture", password: "fixture" },
    { onExists: () => {}, onFlags: () => {}, onExpunge: () => {}, onClose: () => {} },
  );
  const label = "Trips/東京 2026";
  session.client.capabilities.set("X-GM-EXT-1", true);
  session.customPaths = [label];
  session.client.mailbox = {
    path: "All Mail",
    delimiter: "/",
    flags: new Set(),
    permanentFlags: new Set(["\\Seen"]),
    uidValidity: 1n,
    uidNext: 3,
    exists: 2,
  };
  using add = vi.spyOn(session.client, "messageFlagsAdd").mockResolvedValue(true);
  using remove = vi.spyOn(session.client, "messageFlagsRemove").mockResolvedValue(false);
  using _fetch = vi.spyOn(session.client, "fetch").mockImplementation(async function* () {
    yield {
      uid: 2,
      seq: 2,
      flags: new Set(["\\Seen"]),
      labels: new Set(["\\Inbox", "Family", label]),
    };
  });
  expect(await session.setLabel([2], label, true)).toEqual([
    { uid: 2, seen: true, labels: ["\\Inbox", "Family", label] },
  ]);
  expect(add).toHaveBeenCalledWith("2", [label], { uid: true, useLabels: true });
  await expect(session.setLabel([2], label, false)).rejects.toThrow("declined");
  expect(remove).toHaveBeenCalledWith("2", [label], { uid: true, useLabels: true });
  await expect(session.setLabel([2], "\\Inbox", false)).rejects.toThrow("no longer available");
  expect(remove).toHaveBeenCalledTimes(1);
});

it("downloads only the selected MIME attachment even when filenames match", async () => {
  const session = new ImapSession(
    { host: "localhost", port: 1, secure: false, user: "fixture", password: "fixture" },
    { onExists: () => {}, onFlags: () => {}, onExpunge: () => {}, onClose: () => {} },
  );
  const file = {
    type: "application/pdf",
    disposition: "attachment",
    dispositionParameters: { filename: "invoice.pdf" },
  };
  using _structure = vi.spyOn(session.client, "fetchOne").mockResolvedValue({
    seq: 1,
    uid: 3,
    bodyStructure: { type: "multipart/mixed", childNodes: [{ type: "text/plain" }, file, file] },
  });
  using download = vi.spyOn(session.client, "download").mockImplementation(async () => ({
    meta: {},
    content: NodeStream.Readable.from([Buffer.from("paid")]),
  }));
  expect(await session.fetchAttachments(3, 4, 1)).toEqual({
    complete: true,
    files: [
      { filename: "invoice.pdf", contentType: "application/pdf", content: Buffer.from("paid") },
    ],
  });
  expect(await session.fetchAttachments(3, 3, 1)).toEqual({ files: [], complete: false });
  expect(await session.fetchAttachments(3, 4, 2)).toEqual({ files: [], complete: true });
  expect(download.mock.calls.map(([, part]) => part)).toEqual(["3", "3"]);
});
