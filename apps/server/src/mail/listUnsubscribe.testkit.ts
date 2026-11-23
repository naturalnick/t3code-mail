// @effect-diagnostics nodeBuiltinImport:off -- fixture keys for DKIM-signed test messages.
import * as NodeCrypto from "node:crypto";

import * as Nodemailer from "nodemailer";

const keys = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

/** The DKIM TXT record for `keys`, as the signer's DNS would publish it. */
export const dkimRecord = (extra = "") =>
  `v=DKIM1; k=rsa;${extra} p=${keys.publicKey.export({ type: "spki", format: "der" }).toString("base64")}`;

/** A message signed by nodemailer's DKIM signer, independent of the verifier under test. */
export async function signedMessage(input: {
  readonly from?: string;
  readonly domain?: string;
  readonly signed?: string;
  readonly headers?: Record<string, string | Array<string>>;
}): Promise<Buffer> {
  const transport = Nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "windows",
    dkim: {
      domainName: input.domain ?? "example.com",
      keySelector: "sel",
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      headerFieldNames:
        input.signed ?? "From:To:Subject:Date:Message-ID:List-Unsubscribe:List-Unsubscribe-Post",
    },
  });
  const info = await transport.sendMail({
    from: input.from ?? "News <news@mail.example.com>",
    to: "me@example.org",
    subject: "Weekly news",
    text: "Hello  there \n\n",
    headers: input.headers ?? {
      "List-Unsubscribe": "<https://example.com/u?id=1>, <mailto:leave@example.com?subject=stop>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  return info.message as Buffer;
}
