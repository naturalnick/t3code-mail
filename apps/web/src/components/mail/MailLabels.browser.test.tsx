import "~/index.css";
import { MailAccountId, type MailLabelScope } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { MailLabelFilter } from "./MailLabels";

it("searches account-scoped labels from the icon with the keyboard and clears the selection", async () => {
  const accounts = [
    { id: MailAccountId.make("work"), email: "work@example.test", labels: ["Receipts"] },
    { id: MailAccountId.make("home"), email: "home@example.test", folders: ["Receipts"] },
  ];
  function Filter() {
    const [scope, setScope] = useState<MailLabelScope | null>(null);
    return (
      <SidebarProvider>
        <MailLabelFilter accounts={accounts} scope={scope} onPick={setScope} />
        <output>{scope && [scope.accountId, scope.kind, scope.name].join("/")}</output>
      </SidebarProvider>
    );
  }
  await using screen = await render(<Filter />);
  await screen.getByRole("combobox", { name: "Filter by label" }).click();
  await page.getByLabelText("Search labels").fill("home");
  await expect.element(page.getByText("home@example.test", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("work@example.test", { exact: true }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("status")).toHaveTextContent("home/folder/Receipts");
  await screen.getByRole("combobox", { name: "Filter by label · Receipts" }).click();
  await page.getByRole("button", { name: "Clear label filter" }).click();
  await expect.element(screen.getByRole("combobox", { name: "Filter by label" })).toBeVisible();
});
