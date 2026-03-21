type SerializeContext = {
  listDepth: number;
};

const BLOCK_TAGS = new Set(["p", "div", "section", "article", "blockquote", "table", "thead", "tbody", "tr", "ul", "ol", "li"]);

export const isSelectionInside = (selection: Selection | null, root: HTMLElement | null) => {
  if (!selection || !root || selection.rangeCount === 0) return false;
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  return (!!anchorNode && root.contains(anchorNode)) || (!!focusNode && root.contains(focusNode));
};

const getKatexSource = (element: Element) => {
  const container = element.closest(".katex-display") ?? element.closest(".katex") ?? element;
  const annotation = container.querySelector("annotation[encoding='application/x-tex']") ?? container.querySelector("annotation");
  const tex = annotation?.textContent?.trim();
  if (!tex) return "";
  return container.classList.contains("katex-display") ? `$$${tex}$$` : `$${tex}$`;
};

const serializeChildren = (node: Node, context: SerializeContext) =>
  Array.from(node.childNodes)
    .map((child) => serializeNode(child, context))
    .join("");

const normalizeInline = (value: string) => value.replace(/[ \t]+\n/g, "\n");

const prefixLines = (value: string, prefix: string) =>
  value
    .split("\n")
    .map((line) => (line ? `${prefix}${line}` : prefix.trimEnd()))
    .join("\n");

const serializeListItem = (element: HTMLElement, context: SerializeContext) => {
  const parent = element.parentElement;
  const ordered = parent?.tagName.toLowerCase() === "ol";
  const siblings = parent ? Array.from(parent.children).filter((child) => child.tagName.toLowerCase() === "li") : [];
  const index = Math.max(0, siblings.indexOf(element));
  const marker = ordered ? `${index + 1}. ` : "- ";
  const indent = "  ".repeat(context.listDepth);

  const inlineParts: string[] = [];
  const nestedParts: string[] = [];
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as HTMLElement).tagName.toLowerCase();
      if (tag === "ul" || tag === "ol") {
        nestedParts.push(serializeNode(child, { listDepth: context.listDepth + 1 }));
        continue;
      }
    }
    inlineParts.push(serializeNode(child, context));
  }

  const inlineText = normalizeInline(inlineParts.join("")).trim();
  const nestedText = nestedParts.join("").trimEnd();
  let result = inlineText ? `${indent}${marker}${inlineText}` : `${indent}${marker}`.trimEnd();
  if (nestedText) result += `\n${nestedText}`;
  return `${result}\n`;
};

const serializeTable = (element: HTMLElement, context: SerializeContext) => {
  const rows = Array.from(element.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr"));
  if (rows.length === 0) return "";

  const lines = rows.map((row) => {
    const cells = Array.from(row.children)
      .filter((cell) => ["th", "td"].includes(cell.tagName.toLowerCase()))
      .map((cell) => normalizeInline(serializeChildren(cell, context)).replace(/\n+/g, " ").trim());
    return `| ${cells.join(" | ")} |`;
  });

  const headerCells = Array.from(rows[0].children).filter((cell) => ["th", "td"].includes(cell.tagName.toLowerCase())).length;
  if (headerCells > 0) {
    lines.splice(1, 0, `| ${Array.from({ length: headerCells }, () => "---").join(" | ")} |`);
  }
  return `${lines.join("\n")}\n\n`;
};

const serializeNode = (node: Node, context: SerializeContext): string => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const element = node as HTMLElement;
  if (element.matches(".katex-display") || element.matches(".katex")) return getKatexSource(element);

  const tag = element.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "hr") return "\n---\n\n";
  if (tag === "img") {
    const alt = element.getAttribute("alt") ?? "";
    const src = element.getAttribute("src") ?? "";
    return src ? `![${alt}](${src})` : alt;
  }

  const content = serializeChildren(element, context);
  if (!content && !element.querySelector(".katex")) return "";

  if (tag === "strong" || tag === "b") return `**${content.trim()}**`;
  if (tag === "em" || tag === "i") return `*${content.trim()}*`;
  if (tag === "del" || tag === "s") return `~~${content.trim()}~~`;
  if (tag === "a") {
    const href = element.getAttribute("href") ?? "";
    const label = content.trim() || href;
    return href ? `[${label}](${href})` : label;
  }
  if (tag === "code" && element.parentElement?.tagName.toLowerCase() !== "pre") return content ? `\`${content}\`` : "";
  if (tag === "pre") {
    const code = content.replace(/^\n+|\n+$/g, "");
    return code ? `\n\`\`\`\n${code}\n\`\`\`\n\n` : "";
  }
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    return `${"#".repeat(level)} ${normalizeInline(content).trim()}\n\n`;
  }
  if (tag === "blockquote") {
    const text = normalizeInline(content).trim();
    return text ? `${prefixLines(text, "> ")}\n\n` : "";
  }
  if (tag === "li") return serializeListItem(element, context);
  if (tag === "ul" || tag === "ol") return `${serializeChildren(element, context)}\n`;
  if (tag === "table") return serializeTable(element, context);

  if (BLOCK_TAGS.has(tag)) {
    const text = normalizeInline(content).trim();
    return text ? `${text}\n\n` : "";
  }

  return content;
};

export const extractSelectionMarkdown = (selection: Selection | null, root?: HTMLElement | null) => {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return "";
  const range = selection.getRangeAt(0);
  const scope = root ?? (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? (range.commonAncestorContainer as HTMLElement) : range.commonAncestorContainer.parentElement);
  if (!scope) return selection.toString().trim();

  const fragment = range.cloneContents();
  const markdown = serializeChildren(fragment, { listDepth: 0 })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return markdown || selection.toString().trim();
};
