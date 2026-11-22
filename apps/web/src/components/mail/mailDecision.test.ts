import type { MailRule } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { threadAutoSettleRules } from "./mailDecision";

it("opens the applicable rule without treating every condition on a sender as a match", () => {
  const message = {
    from: { name: "Store", address: "updates@shop.example" },
    subject: "Shipped",
    listId: "<orders>",
    outgoing: false,
  };
  const sender: MailRule = {
    id: "sender",
    match: { from: "<updates@shop.example>" },
    enabled: true,
    reason: "fyi",
  };
  const shipping = { ...sender, id: "shipping", when: "Shipping updates" };
  const orders = { ...sender, id: "orders", match: { listId: "orders" } };
  expect(threadAutoSettleRules([shipping], message, null)).toEqual({
    inScope: [shipping],
    applied: null,
  });
  expect(
    threadAutoSettleRules([{ ...shipping, enabled: false }], message, shipping.id).inScope,
  ).toEqual([]);
  expect(threadAutoSettleRules([orders, shipping], message, shipping.id).applied).toBe(shipping);
  expect(threadAutoSettleRules([orders, shipping], message, null).applied).toBe(orders);
  expect(threadAutoSettleRules([sender], { ...message, outgoing: true }, null).inScope).toEqual([]);
});
