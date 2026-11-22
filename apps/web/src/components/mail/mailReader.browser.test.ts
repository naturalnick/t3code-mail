import { describe, expect, it } from "vite-plus/test";

import { readerView } from "./mailReader";

const read = (html: string) => {
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content.ownerDocument.createElement("div");
  content.append(template.content);
  const result = readerView(content);
  const view = document.createElement("div");
  view.innerHTML = result.html;
  return { ...result, view };
};

const IMAGES = '<img src="https://cdn.example/a.png">'.repeat(4);

describe("readerView", () => {
  it("keeps an item beside its price and drops the layout around it", () => {
    const { view } = read(`
      <table><tr><td><table><tr>
        <td><img src="https://cdn.example/beer.jpg"></td>
        <td><span>Galaxy Ripple × 1</span><br><span>6-Pack</span></td>
        <td><p>$13.99</p></td>
      </tr></table></td></tr></table>`);
    const line = view.querySelector("[data-line]");
    expect([...line!.children].map((cell) => cell.textContent?.trim())).toEqual([
      "Galaxy Ripple × 16-Pack",
      "$13.99",
    ]);
    expect(view.querySelector("img, table, p")).toBeNull();
  });

  it("keeps the sender's words, line breaks and link destinations, decoding entities", () => {
    const { view } = read(`
      <div style="display:none">Preheader &zwnj;&nbsp;&zwnj;</div>
      <p style="color:#777">No signature is required &amp; cheers!</p>
      <p>Nick<br>4 Old Garden Road<br><br><br>Rockport</p>
      <table><tr><td style="background:#000"><a href="https://shop.example/order" style="padding:12px">View your order</a></td></tr></table>
      <a href="https://shop.example/"><img alt="Shop" src="https://cdn.example/logo.png"></a>
      <a href="javascript:alert(1)">Bad</a>`);
    expect(view.textContent).not.toContain("Preheader");
    expect(view.textContent).toContain("No signature is required & cheers!");
    expect(view.querySelector("p:nth-of-type(2)")?.innerHTML).toBe(
      "Nick<br>4 Old Garden Road<br>Rockport",
    );
    expect(
      [...view.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["View your order", "https://shop.example/order"],
      ["Shop", "https://shop.example/"],
    ]);
    expect(view.textContent).toContain("Bad");
    expect(view.querySelector("[style]")).toBeNull();
  });

  it("keeps text a child makes visible again and drops what is really hidden", () => {
    const { view } = read(`
      <div style="font-size:0"><span style="font-size:16px">Pickup code 4821</span> </div>
      <div style="visibility:hidden">Ghost <b style="visibility:visible">Shown</b></div>
      <div style="mso-hide:all">Not Outlook</div>
      <table>
        <tr><td>Status</td><td>Confirmed</td></tr>
        <tr style="display:none"><td>Status</td><td>Cancelled</td></tr>
        <tbody style="display:none"><tr><td>Hidden</td><td>group</td></tr></tbody>
      </table>`);
    expect(view.textContent).toContain("Pickup code 4821");
    expect(view.textContent).toContain("Shown");
    expect(view.textContent).not.toContain("Ghost");
    expect(view.textContent).toContain("Not Outlook");
    expect(view.textContent).toContain("Confirmed");
    expect(view.textContent).not.toMatch(/Cancelled|Hidden/);
  });

  it("keeps the spaces between words, lines and blocks", () => {
    const { view } = read(`
      <a href="https://air.example/pass"><div>Gate</div><div>12</div></a>
      <div><strong>Boarding 9:40</strong></div><div><em>Seat 14C</em></div>
      <p>View<strong> </strong>order</p>
      <p>من‌ می‌روم 👩‍💻</p>`);
    expect(view.querySelector("a")?.textContent).toBe("Gate 12");
    expect([...view.children].map((block) => block.textContent?.trim())).toEqual(
      expect.arrayContaining(["Boarding 9:40", "Seat 14C"]),
    );
    expect(view.textContent).toContain("View order");
    expect(view.textContent).toContain("من‌ می‌روم 👩‍💻");
  });

  it("labels a picture link so its destination stays reachable", () => {
    const { view } = read(`
      <a href="https://air.example/checkin"><img title="Check in" src="https://cdn.example/b.png"></a>
      <a href="https://social.example/us"><img src="https://cdn.example/icon.png" width="24"></a>
      <a href="https://track.example/open"><img src="https://track.example/p.gif" width="1" height="1"></a>`);
    expect(
      [...view.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Check in", "https://air.example/checkin"],
      ["social.example", "https://social.example/us"],
    ]);
  });

  it("keeps data tables as tables", () => {
    const { view } = read(`
      <table>
        <tr><th>Quantity</th><th>Price</th></tr>
        <tr><td>10</td><td>$109.25</td></tr>
      </table>
      <table>
        <tr><td>Symbol</td><td>Shares</td><td>Total</td></tr>
        <tr><td>ANT</td><td>10</td><td>$1,092.45</td></tr>
      </table>
      <table>
        <caption>Flights</caption>
        <tr><th>Flight</th><th>Leg</th></tr>
        <tr><td rowspan="2">UA 12</td><td>SFO-ORD</td></tr>
        <tr><td>ORD-BOS</td></tr>
      </table>`);
    expect(view.querySelector("caption")?.textContent).toBe("Flights");
    expect(view.querySelector("td[rowspan='2']")?.textContent).toBe("UA 12");
    expect(
      [...view.querySelectorAll("tr")].map((row) =>
        [...row.children].map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["Quantity", "Price"],
      ["10", "$109.25"],
      ["Symbol", "Shares", "Total"],
      ["ANT", "10", "$1,092.45"],
      ["Flight", "Leg"],
      ["UA 12", "SFO-ORD"],
      ["ORD-BOS"],
    ]);
  });

  it("keeps quoted history marked so it folds", () => {
    const { view } = read(`<p>Sounds good.</p><div data-t3-quote><p>Earlier message</p></div>`);
    expect(view.querySelector("[data-t3-quote]")?.textContent).toBe("Earlier message");
  });

  it.each([
    { name: "an email made of images", html: `${IMAGES}<p>You're covered.</p>`, useful: false },
    { name: "a short note without images", html: "<p>Thanks!</p>", useful: true },
    {
      name: "a long email with images",
      html: `${IMAGES}<p>${"Words ".repeat(50)}</p>`,
      useful: true,
    },
    { name: "an email with no text", html: IMAGES, useful: false },
    {
      name: "a short receipt with a logo, a product and a tracking pixel",
      html: `<img src="https://cdn.example/logo.png"><img src="https://cdn.example/item.png"><img src="https://t.example/p.gif" width="1" height="1"><p>Tea × 1 $4.00</p>`,
      useful: true,
    },
    {
      name: "a picture with only quoted history as text",
      html: `${IMAGES}<div style="display:none">Your pickup is ready</div><div data-t3-quote><p>${"Earlier ".repeat(40)}</p></div>`,
      useful: false,
    },
  ])("opens $name in the simplified view: $useful", ({ html, useful }) => {
    expect(read(html).useful).toBe(useful);
  });
});
