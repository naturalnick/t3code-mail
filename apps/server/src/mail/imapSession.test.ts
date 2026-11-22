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
