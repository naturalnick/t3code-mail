import "~/index.css";
import { EnvironmentId, MailThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { fetchMailAttachment } from "../../state/mailAttachment";
import { MailAttachmentItem } from "./MailAttachmentItem";

vi.mock("../../state/mailAttachment", { spy: true });

it("opens the selected file on demand and saves the original bytes with its filename", async () => {
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/QisAAAAASUVORK5CYII=",
    ),
    (char) => char.charCodeAt(0),
  );
  const load = vi.mocked(fetchMailAttachment).mockReset().mockResolvedValue(bytes);
  const input = { threadId: MailThreadId.make("thread"), messageId: 31, index: 2 };
  const environmentId = EnvironmentId.make("local");
  await using screen = await render(
    <ul>
      <MailAttachmentItem
        file={{ filename: "receipt.png", contentType: "image/png", size: bytes.length }}
        input={input}
        environmentId={environmentId}
      />
    </ul>,
  );
  expect(load).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Preview receipt.png" }).click();
  await expect.element(page.getByRole("img", { name: "receipt.png" })).toBeVisible();
  await expect.element(page.getByText("1 × 1")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  expect(load).toHaveBeenCalledWith(environmentId, input, expect.any(AbortSignal));

  let saved: HTMLAnchorElement | undefined;
  using _save = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved = this;
  });
  await screen.getByRole("button", { name: "Download receipt.png" }).click();
  await vi.waitFor(() => expect(saved?.download).toBe("receipt.png"));
  expect(new Uint8Array(await (await fetch(saved!.href)).arrayBuffer())).toEqual(bytes);
});
