/**
 * Reader view: rebuilds a sanitized email from a small set of elements so it reads in T3's own
 * styles. It keeps every visible word and link destination and drops layout, colors and images.
 * Deterministic on purpose: nothing decides which sentence or link the reader can skip.
 */

// Invisible characters with no meaning in text. Joiners (U+200C, U+200D) spell Persian and emoji.
const INVISIBLE = /[\u200b\u2060\ufeff\u180e]/g;
// Inbox-preview padding ("&zwnj;&nbsp;&zwnj;&nbsp;...") that some senders leave visible.
const PADDING = /(?:(?:[\u200c\u00a0\u00ad\u2007]|\u034f)\s*){2,}/g;
const SKIP = new Set(["head", "style", "script", "title", "meta", "link", "template"]);
const INLINE: Record<string, string> = {
  b: "strong",
  strong: "strong",
  i: "em",
  em: "em",
  s: "s",
  del: "s",
  strike: "s",
  code: "code",
  sub: "sub",
  sup: "sup",
};
const BLOCK: Record<string, string> = {
  p: "p",
  blockquote: "blockquote",
  pre: "pre",
  ul: "ul",
  ol: "ol",
  li: "li",
  h1: "h2",
  h2: "h2",
  h3: "h3",
  h4: "h3",
  h5: "h3",
  h6: "h3",
};
const BLOCK_TAGS = new Set(
  "address article aside caption center dd div dl dt figcaption figure footer header main section tbody td tfoot th thead tr".split(
    " ",
  ),
);
const OUTPUT_BLOCKS = "div,p,h2,h3,ul,ol,li,blockquote,pre,table";

const LINE_CLASS = "flex flex-wrap items-baseline justify-between gap-x-4";
/** Text a two-column row can carry and still read as one line, like an item and its price. */
const LINE_CHARS = 160;
/** Below this much text, an email built from several pictures is the pictures. */
const USEFUL_CHARS = 200;
const IMAGE_LED = 3;

export interface ReaderView {
  readonly html: string;
  /** False when the simplified version would lose what the email is, so the original shows first. */
  readonly useful: boolean;
  readonly hasText: boolean;
}

/** What the ancestors' styles do to text: hide it, or shrink it to nothing. */
interface Context {
  readonly invisible: boolean;
  readonly tiny: boolean;
  readonly quoted: boolean;
}

const text = (node: Node) => (node.textContent ?? "").trim();

const declaration = (style: string, property: string) =>
  style
    .match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;!]+)`, "i"))?.[1]
    ?.trim()
    .toLowerCase();

/**
 * The context for an element's content, or null when its whole subtree is hidden. Only what no
 * descendant can undo hides a subtree; font size and visibility can be restored by a child.
 */
function enter(element: Element, context: Context): Context | null {
  if (element.hasAttribute("hidden")) return null;
  const style = element.getAttribute("style") ?? "";
  if (!style) return context;
  if (declaration(style, "display") === "none") return null;
  if (/^0(?:\.0*)?$/.test(declaration(style, "opacity") ?? "")) return null;
  const clipped = declaration(style, "overflow") === "hidden";
  if (clipped && /^0(?:px)?$/.test(declaration(style, "max-height") ?? "")) return null;
  const visibility = declaration(style, "visibility");
  const size = declaration(style, "font-size")?.match(/^(\d*\.?\d+)(px|pt|em|rem|%)?$/);
  return {
    quoted: context.quoted,
    invisible:
      visibility === "hidden" ? true : visibility === "visible" ? false : context.invisible,
    tiny: size
      ? Number(size[1]) === 0 || ((size[2] ?? "px") === "px" && Number(size[1]) <= 1)
      : context.tiny,
  };
}

const isPixel = (image: Element) =>
  ["width", "height"].some((side) => {
    const value =
      image.getAttribute(side) ?? declaration(image.getAttribute("style") ?? "", side) ?? "";
    return /^[0-3](?:px)?$/.test(value.trim());
  });

const cellsOf = (row: Element) =>
  [...row.children].filter((cell) => cell.tagName === "TD" || cell.tagName === "TH");

/** Rows and the context of their row group, skipping hidden groups. */
function rowsOf(table: Element, context: Context): Array<[Element, Context]> {
  const rows: Array<[Element, Context]> = [];
  for (const child of table.children) {
    if (child.tagName === "TR") rows.push([child, context]);
    else if (/^T(?:HEAD|BODY|FOOT)$/.test(child.tagName)) {
      const group = enter(child, context);
      if (group)
        for (const row of child.children) if (row.tagName === "TR") rows.push([row, group]);
    }
  }
  return rows;
}

/** Joins an element's words with the spaces its blocks and line breaks implied. */
function flatText(element: Element) {
  const copy = element.cloneNode(true) as Element;
  for (const br of copy.querySelectorAll("br")) br.replaceWith(" ");
  for (const block of copy.querySelectorAll(OUTPUT_BLOCKS)) {
    block.before(" ");
    block.after(" ");
  }
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

function linkLabel(source: Element, href: string) {
  for (const image of source.querySelectorAll("img")) {
    const label = image.getAttribute("alt")?.trim() || image.getAttribute("title")?.trim();
    if (label) return label;
  }
  const title = source.getAttribute("title")?.trim();
  if (title) return title;
  // An unlabeled picture button still leads somewhere the reader should be able to go.
  if (![...source.querySelectorAll("img")].some((image) => !isPixel(image))) return null;
  if (/^mailto:/i.test(href)) return href.slice(7).split("?")[0] ?? href;
  try {
    return new URL(href).hostname;
  } catch {
    return href;
  }
}

class Builder {
  images = 0;
  constructor(private readonly doc: Document) {}

  children(source: Node, out: Element, context: Context) {
    for (const child of source.childNodes) this.node(child, out, context);
  }

  /** Appends `element` unless conversion left it without text; a lone space still separates words. */
  keep(element: Element, out: Element, inline = false) {
    if (text(element) || element.querySelector("hr")) out.append(element);
    else if (inline && element.textContent) out.append(" ");
  }

  node(source: Node, out: Element, context: Context) {
    if (source.nodeType === Node.TEXT_NODE) {
      if (context.invisible || context.tiny) return;
      const value = (source.textContent ?? "").replace(INVISIBLE, "").replace(PADDING, " ");
      if (value) out.append(value);
      return;
    }
    if (source.nodeType !== Node.ELEMENT_NODE) return;
    const element = source as Element;
    const tag = element.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    const inner = enter(element, context);
    if (inner === null) return;
    if (tag === "img") {
      if (!inner.invisible && !inner.quoted && !isPixel(element)) this.images++;
      return;
    }
    // Quoted history keeps its marker so the reader folds it like the original.
    if (element.hasAttribute("data-t3-quote") && !context.quoted) {
      const quote = this.doc.createElement("div");
      quote.setAttribute("data-t3-quote", "");
      this.convert(element, tag, quote, { ...inner, quoted: true });
      this.keep(quote, out);
      return;
    }
    this.convert(element, tag, out, inner);
  }

  convert(element: Element, tag: string, out: Element, context: Context) {
    if (tag === "br" || tag === "hr") {
      out.append(this.doc.createElement(tag));
      return;
    }
    if (tag === "a") return this.link(element, out, context);
    if (tag === "table") return this.table(element, out, context);
    const inline = INLINE[tag];
    if (inline) {
      const target = this.doc.createElement(inline);
      this.children(element, target, context);
      this.keep(target, out, true);
      return;
    }
    const block = BLOCK[tag];
    if (block || BLOCK_TAGS.has(tag)) {
      const target = this.doc.createElement(block ?? "div");
      this.children(element, target, context);
      this.keep(target, out);
      return;
    }
    // span, font, u and other wrappers carry only presentation.
    this.children(element, out, context);
  }

  link(element: Element, out: Element, context: Context) {
    const href = element.getAttribute("href");
    if (!href || !/^(?:https?:\/\/|mailto:)/i.test(href))
      return this.children(element, out, context);
    const link = this.doc.createElement("a");
    link.setAttribute("href", href);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
    this.children(element, link, context);
    // Block content inside a link is flattened: a link is read as one phrase.
    if (link.querySelector(OUTPUT_BLOCKS)) link.textContent = flatText(link);
    if (!text(link) && !context.invisible && !context.tiny) {
      const label = linkLabel(element, href);
      if (label) link.textContent = label;
    }
    this.keep(link, out, true);
  }

  table(element: Element, out: Element, context: Context) {
    const rows = rowsOf(element, context).flatMap(([row, group]) => {
      const inner = enter(row, group);
      return inner ? [{ row, context: inner }] : [];
    });
    const caption = [...element.children].find((child) => child.tagName === "CAPTION");
    if (
      isGrid(
        rows.map((entry) => entry.row),
        element,
      )
    )
      return this.dataTable(rows, caption, out, context);
    if (caption) this.node(caption, out, context);
    for (const { row, context: rowContext } of rows) {
      // A quoted row folds with the rest of the history.
      const quoted = row.hasAttribute("data-t3-quote") && !rowContext.quoted;
      const target = quoted ? this.doc.createElement("div") : out;
      if (quoted) target.setAttribute("data-t3-quote", "");
      const cellContext = quoted ? { ...rowContext, quoted: true } : rowContext;
      const cells = cellsOf(row).flatMap((cell) => {
        const box = this.doc.createElement("div");
        this.node(cell, box, cellContext);
        const content = box.firstElementChild;
        return content && (text(content) || content.querySelector("hr")) ? [content] : [];
      });
      // An item beside its price, or a label beside its value, stays on one line.
      if (
        cells.length >= 2 &&
        cells.every(
          (cell) =>
            !cell.hasAttribute("data-t3-quote") &&
            text(cell).length <= LINE_CHARS &&
            !cell.querySelector("ul,ol,blockquote,pre,h2,h3,table,[data-line]"),
        )
      ) {
        const line = this.doc.createElement("div");
        line.setAttribute("data-line", "");
        line.className = LINE_CLASS;
        for (const cell of cells) {
          // Paragraph spacing would push one side of the line below the other.
          for (const paragraph of cell.querySelectorAll("p")) {
            const plain = this.doc.createElement("div");
            plain.append(...paragraph.childNodes);
            paragraph.replaceWith(plain);
          }
          line.append(cell);
        }
        line.lastElementChild?.classList.add("text-end");
        target.append(line);
      } else {
        for (const cell of cells) target.append(cell);
      }
      if (quoted) this.keep(target, out);
    }
  }

  dataTable(
    rows: ReadonlyArray<{ row: Element; context: Context }>,
    caption: Element | undefined,
    out: Element,
    context: Context,
  ) {
    const container = this.doc.createElement("div");
    container.className = "chat-markdown-table-container overflow-x-auto";
    const table = this.doc.createElement("table");
    const captionContext = caption ? enter(caption, context) : null;
    if (caption && captionContext) {
      const target = this.doc.createElement("caption");
      this.children(caption, target, captionContext);
      if (text(target)) table.append(target);
    }
    const body = this.doc.createElement("tbody");
    for (const { row, context: rowContext } of rows) {
      const tr = this.doc.createElement("tr");
      if (row.hasAttribute("data-t3-quote")) tr.setAttribute("data-t3-quote", "");
      for (const cell of cellsOf(row)) {
        const cellContext = enter(cell, rowContext);
        if (cellContext === null) continue;
        const target = this.doc.createElement(cell.tagName === "TH" ? "th" : "td");
        for (const name of ["colspan", "rowspan"]) {
          const span = cell.getAttribute(name);
          if (span && /^[1-9]\d?$/.test(span)) target.setAttribute(name, span);
        }
        this.children(cell, target, cellContext);
        tr.append(target);
      }
      // An empty row can still hold a rowspan's place, so only rows with no cells are dropped.
      if (tr.children.length > 0) body.append(tr);
    }
    table.append(body);
    container.append(table);
    this.keep(container, out);
  }
}

/**
 * A table of data rather than layout: it has header cells, or at least two rows of three or more
 * short cells in matching columns, like a trade confirmation.
 */
function isGrid(rows: ReadonlyArray<Element>, table: Element) {
  if (rows.some((row) => cellsOf(row).some((cell) => cell.tagName === "TH"))) return true;
  if (table.querySelector("table")) return false;
  const filled = rows.filter((row) => text(row));
  const width = filled[0] ? cellsOf(filled[0]).length : 0;
  return (
    width >= 3 &&
    filled.length >= 2 &&
    filled.every(
      (row) =>
        cellsOf(row).length === width &&
        cellsOf(row).every((cell) => text(cell).length <= LINE_CHARS),
    )
  );
}

/** Collapses wrapper divs that hold a single block, which layout emails nest many levels deep. */
function unwrap(root: Element) {
  for (const div of [...root.querySelectorAll("div:not([class]):not([data-t3-quote])")].reverse()) {
    const only = div.childNodes.length === 1 ? div.firstElementChild : null;
    if (only?.matches(OUTPUT_BLOCKS)) div.replaceWith(only);
  }
  // Runs of line breaks are spacing in the original layout.
  for (const br of root.querySelectorAll("br")) {
    let before = br.previousSibling;
    while (before?.nodeType === Node.TEXT_NODE && !before.textContent?.trim())
      before = before.previousSibling;
    if (before === null || (before as Element).tagName === "BR") br.remove();
  }
}

const visibleChars = (element: Element) =>
  (element.textContent ?? "").replace(/\s+/g, " ").trim().length;

/** `content` is the sanitized email, with quoted history already marked. It is not modified. */
export function readerView(content: Element): ReaderView {
  const doc = content.ownerDocument;
  const root = doc.createElement("div");
  const builder = new Builder(doc);
  builder.children(content, root, { invisible: false, tiny: false, quoted: false });
  unwrap(root);
  // Folded history is not what this message says, so it doesn't count toward its text.
  const current = root.cloneNode(true) as Element;
  for (const quote of current.querySelectorAll("[data-t3-quote]")) quote.remove();
  const chars = visibleChars(current);
  return {
    html: root.innerHTML,
    useful: chars > 0 && (chars >= USEFUL_CHARS || builder.images < IMAGE_LED),
    hasText: visibleChars(root) > 0,
  };
}
