import { describe, expect, it } from "vite-plus/test";

import { planUnsubscribe } from "./listUnsubscribe.ts";
import { dkimRecord, signedMessage } from "./listUnsubscribe.testkit.ts";

const dns =
  (records: Record<string, string> = { "sel._domainkey.example.com": dkimRecord() }) =>
  async (name: string) =>
    records[name] === undefined ? [] : [records[name]!];

const now = 1_795_000_000;

const plain = (headers: string) =>
  Buffer.from(`${headers.trim().split("\n").join("\r\n")}\r\n\r\nHello\r\n`, "latin1");

describe("planUnsubscribe", () => {
  it("offers one-click only for a DKIM signature from the From domain covering both headers", async () => {
    const source = await signedMessage({});
    expect(await planUnsubscribe(source, dns(), now)).toMatchObject({
      method: "one_click",
      target: "example.com",
      pageUrl: "https://example.com/u?id=1",
      oneClickUrl: new URL("https://example.com/u?id=1"),
      email: { address: "leave@example.com", subject: "stop" },
    });
  });

  it("falls back to the sender's email when the one-click request can't be trusted", async () => {
    const tampered = (await signedMessage({}))
      .toString("latin1")
      .replace("https://example.com/u?id=1", "https://attacker.test/u?id=1");
    const cases = [
      // The URL changed after signing.
      Buffer.from(tampered, "latin1"),
      // The signature doesn't cover List-Unsubscribe-Post.
      await signedMessage({ signed: "From:To:Subject:List-Unsubscribe" }),
      // Signed by a domain that isn't the sender's.
      await signedMessage({ domain: "example.com", from: "Bank <alerts@bank.test>" }),
      // A second List-Unsubscribe is ambiguous.
      await signedMessage({
        headers: {
          "List-Unsubscribe": ["<https://example.com/u?id=1>", "<mailto:leave@example.com>"],
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    ];
    for (const source of cases) {
      expect((await planUnsubscribe(source, dns(), now))?.method).toBe("email");
    }
    const signed = await signedMessage({});
    // No key, a revoked key, or a signer still testing its key.
    for (const records of [
      {},
      { "sel._domainkey.example.com": "v=DKIM1; p=" },
      { "sel._domainkey.example.com": dkimRecord(" t=y;") },
    ]) {
      expect((await planUnsubscribe(signed, dns(records), now))?.method).toBe("email");
    }
  });

  it("reads mailto and web links from an unsigned header", async () => {
    expect(
      await planUnsubscribe(
        plain(`From: list@lists.example.org
List-Unsubscribe: <mailto:list-request@lists.example.org?subject=unsubscribe%20me>`),
        dns(),
        now,
      ),
    ).toMatchObject({
      method: "email",
      target: "list-request@lists.example.org",
      pageUrl: null,
      email: { subject: "unsubscribe me", body: "Unsubscribe" },
    });
    expect(
      await planUnsubscribe(
        plain(`From: news@example.com
List-Unsubscribe: <https://example.com/leave>
List-Unsubscribe-Post: List-Unsubscribe=One-Click`),
        dns(),
        now,
      ),
    ).toMatchObject({
      method: "link",
      target: "example.com",
      pageUrl: "https://example.com/leave",
    });
    expect(
      await planUnsubscribe(
        plain(`From: news@example.com
List-Unsubscribe: <javascript:alert(1)>, <https://user:pw@example.com/x>, <mailto:a@b, c@d>`),
        dns(),
        now,
      ),
    ).toBeNull();
    expect(await planUnsubscribe(plain("From: news@example.com"), dns(), now)).toBeNull();
  });
});
