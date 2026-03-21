import MarkdownIt from "markdown-it";
import dollarmathPlugin from "markdown-it-dollarmath";
import katex from "katex";
import { invoke } from "@tauri-apps/api/core";
import katexStyles from "katex/dist/katex.min.css?inline";
import pagedJsPolyfillUrl from "../../node_modules/pagedjs/dist/paged.polyfill.js?url";
import type { PdfExportHeaderFooter, PdfExportSettings, PdfExportSlot } from "../types";
import {
  ALIGN_TAG_NAMES,
  EXTERNAL_PROTOCOL_RE,
  UNSAFE_PROTOCOL_RE,
  getFileName,
  guessImageMimeType,
  normalizeMarkdownDocument,
  parsePdfQuoteBlock,
  resolveDocumentTarget,
  sanitizeAssetString,
  stripWrappingQuotes
} from "./markdownNormalizeService";

type PrintEnhanceOptions = {
  sourcePath: string;
  language: "zh" | "en";
};

type PdfExportDebugManifest = {
  createdAt: string;
  language: "zh" | "en";
  sourcePath: string;
  title: string;
  pageSize: PdfExportSettings["pageSize"];
  landscape: boolean;
  margins: PdfExportSettings["margins"];
  scale: number;
  resourceCount: number;
  resources: ReturnType<typeof normalizeMarkdownDocument>["resources"];
};

type NativePrintHeaderFooterOptions = {
  enabled: boolean;
  headerTitle: string;
  footerUri: string;
};

type PdfPrintDocumentMeta = {
  documentPath?: string;
  documentTitle?: string;
};

const CSS_URL_RE = /url\((['"]?)([^)'"]+)\1\)/g;

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const escapeCssString = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\A ");

const escapeInlineScript = (value: string) => value.replace(/<\/script/gi, "<\\/script");

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Failed to convert blob to data URL."));
    reader.readAsDataURL(blob);
  });

const fetchAsDataUrl = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`asset fetch failed: ${response.status}`);
  return blobToDataUrl(await response.blob());
};

const fetchAsText = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`asset fetch failed: ${response.status}`);
  return response.text();
};

let embeddedKatexStylesPromise: Promise<string> | null = null;
let embeddedPagedJsSourcePromise: Promise<string> | null = null;

const resolveCssAssetUrl = (assetPath: string) => {
  const trimmed = assetPath.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:") || trimmed.startsWith("#")) {
    return "";
  }

  try {
    return new URL(trimmed, trimmed.startsWith("/") ? window.location.origin : window.location.href).href;
  } catch {
    return trimmed;
  }
};

const embedStylesheetAssets = async (stylesheet: string) => {
  const assetPaths = Array.from(new Set(Array.from(stylesheet.matchAll(CSS_URL_RE)).map((match) => match[2].trim()).filter(Boolean)));
  if (assetPaths.length === 0) return stylesheet;

  const replacements = new Map<string, string>();

  await Promise.all(
    assetPaths.map(async (assetPath) => {
      const resolvedUrl = resolveCssAssetUrl(assetPath);
      if (!resolvedUrl) return;

      try {
        replacements.set(assetPath, await fetchAsDataUrl(resolvedUrl));
      } catch {
        replacements.set(assetPath, resolvedUrl);
      }
    })
  );

  return stylesheet.replace(CSS_URL_RE, (full, _quote, assetPath) => {
    const resolved = replacements.get(assetPath.trim());
    return resolved ? `url("${resolved}")` : full;
  });
};

const getEmbeddedKatexStyles = async () => {
  if (!embeddedKatexStylesPromise) {
    embeddedKatexStylesPromise = embedStylesheetAssets(katexStyles).catch((error) => {
      embeddedKatexStylesPromise = null;
      throw error;
    });
  }

  return embeddedKatexStylesPromise;
};

const getEmbeddedPagedJsSource = async () => {
  if (!embeddedPagedJsSourcePromise) {
    embeddedPagedJsSourcePromise = fetchAsText(resolveCssAssetUrl(pagedJsPolyfillUrl))
      .then(escapeInlineScript)
      .catch((error) => {
        embeddedPagedJsSourcePromise = null;
        throw error;
      });
  }

  return embeddedPagedJsSourcePromise;
};

const readLocalFileAsDataUrl = async (path: string, mimeType?: string) => {
  const bytes = await invoke<number[]>("read_binary_file", { path });
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType || guessImageMimeType(path) });
  return blobToDataUrl(blob);
};

const encodeMathSource = (value: string) => encodeURIComponent(value);

const decodeMathSource = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const buildMathMarkup = (content: string, displayMode: boolean) => {
  const tagName = displayMode ? "div" : "span";
  const className = displayMode ? "markdown-math markdown-math-display" : "markdown-math markdown-math-inline";
  const fallback = displayMode ? `\\[${content}\\]` : `\\(${content}\\)`;
  return `<${tagName} class="${className}" data-math-source="${escapeHtml(encodeMathSource(content))}" data-math-display="${displayMode ? "true" : "false"}">${escapeHtml(fallback)}</${tagName}>`;
};

const normalizeBlockDollarMath = (markdown: string) => {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const output: string[] = [];
  let fenceMarker: string | null = null;
  let blockMathBuffer: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const trimmedStart = line.trimStart();
    const fenceMatch = trimmedStart.match(/^(```+|~~~+)/);

    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!blockMathBuffer) {
        if (!fenceMarker) {
          fenceMarker = marker;
        } else if (trimmedStart.startsWith(fenceMarker)) {
          fenceMarker = null;
        }
      }
      output.push(line);
      continue;
    }

    if (fenceMarker) {
      output.push(line);
      continue;
    }

    if (blockMathBuffer) {
      if (trimmed === "$$") {
        output.push(buildMathMarkup(blockMathBuffer.join("\n").trim(), true));
        output.push("");
        blockMathBuffer = null;
        continue;
      }

      blockMathBuffer.push(line);
      continue;
    }

    if (trimmed === "$$") {
      if (output[output.length - 1]?.trim()) {
        output.push("");
      }
      blockMathBuffer = [];
      continue;
    }

    const singleLineMatch = line.match(/^(\s*)\$\$(.+?)\$\$\s*$/);
    if (singleLineMatch && singleLineMatch[2]?.trim()) {
      output.push(buildMathMarkup(singleLineMatch[2].trim(), true));
      output.push("");
      continue;
    }

    output.push(line);
  }

  if (blockMathBuffer) {
    output.push("$$");
    output.push(...blockMathBuffer);
  }

  return output.join("\n");
};

const isEscapedMathDelimiter = (source: string, index: number) => {
  let backslashCount = 0;
  let cursor = index;

  while (cursor > 0 && source.charCodeAt(cursor - 1) === 0x5c) {
    backslashCount += 1;
    cursor -= 1;
  }

  return backslashCount % 2 === 1;
};

const backslashMathInlineRule = (state: any, silent: boolean) => {
  if (state.src.charCodeAt(state.pos) !== 0x5c) return false;

  const marker = state.src.charCodeAt(state.pos + 1);
  const displayMode = marker === 0x5b;
  if (!displayMode && marker !== 0x28) return false;
  if (isEscapedMathDelimiter(state.src, state.pos)) return false;

  const closeMarker = displayMode ? "\\]" : "\\)";
  let searchIndex = state.pos + 2;
  let end = -1;

  while (searchIndex < state.posMax) {
    end = state.src.indexOf(closeMarker, searchIndex);
    if (end < 0) return false;
    if (!isEscapedMathDelimiter(state.src, end)) break;
    searchIndex = end + 2;
  }

  if (end < 0) return false;

  const content = state.src.slice(state.pos + 2, end);
  if (!content.trim()) return false;

  if (!silent) {
    const token = state.push(displayMode ? "math_inline_tex_display" : "math_inline_tex", "math", 0);
    token.content = content;
    token.markup = displayMode ? "\\[" : "\\(";
  }

  state.pos = end + 2;
  return true;
};

const backslashMathBlockRule = (state: any, startLine: number, endLine: number, silent: boolean) => {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  const startMax = state.eMarks[startLine];

  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (startPos + 2 > startMax) return false;

  const firstLine = state.src.slice(startPos, startMax);
  if (!firstLine.startsWith("\\[")) return false;

  let nextLine = startLine;
  let found = false;
  const contentLines: string[] = [];
  let current = firstLine.slice(2);

  while (true) {
    const closeIndex = current.indexOf("\\]");
    if (closeIndex >= 0 && !isEscapedMathDelimiter(current, closeIndex)) {
      if (current.slice(closeIndex + 2).trim()) return false;
      contentLines.push(current.slice(0, closeIndex));
      found = true;
      break;
    }

    contentLines.push(current);
    nextLine += 1;
    if (nextLine >= endLine) break;

    const linePos = state.bMarks[nextLine] + state.tShift[nextLine];
    const lineMax = state.eMarks[nextLine];
    current = state.src.slice(linePos, lineMax);
  }

  if (!found) return false;
  if (silent) return true;

  const token = state.push("math_block_tex", "math", 0);
  token.block = true;
  token.content = contentLines.join("\n").trim();
  token.map = [startLine, nextLine + 1];
  token.markup = "\\[";
  state.line = nextLine + 1;
  return true;
};

const renderFence = (token: { info: string; content: string }) => {
  const language = token.info.trim().split(/\s+/)[0] ?? "";
  if (language === "pdf-quote") {
    const parsed = parsePdfQuoteBlock(token.content);
    if (parsed) {
      return `<blockquote class="pdf-quote-block">
        <div class="pdf-quote-header">${escapeHtml(parsed.meta.name)} / page ${parsed.meta.page}</div>
        <div class="pdf-quote-content">${escapeHtml(parsed.text)}</div>
      </blockquote>`;
    }
  }

  const className = language ? ` class="language-${escapeHtml(language)}"` : "";
  return `<pre class="markdown-code-block"><code${className}>${escapeHtml(token.content)}</code></pre>`;
};

const markdownRenderer = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false
});

markdownRenderer.use(dollarmathPlugin, {
  allow_space: true,
  allow_digits: true,
  allow_labels: true,
  renderer: (content: string, options: { displayMode: boolean }) => buildMathMarkup(content, options.displayMode)
});

markdownRenderer.inline.ruler.before("escape", "math_inline_tex", backslashMathInlineRule);
markdownRenderer.block.ruler.before("fence", "math_block_tex", backslashMathBlockRule);

markdownRenderer.renderer.rules.fence = (tokens: Array<{ info: string; content: string }>, index: number) => renderFence(tokens[index]);
markdownRenderer.renderer.rules.math_inline_tex = (tokens: Array<{ content: string }>, index: number) => buildMathMarkup(tokens[index].content, false);
markdownRenderer.renderer.rules.math_inline_tex_display = (tokens: Array<{ content: string }>, index: number) => buildMathMarkup(tokens[index].content, true);
markdownRenderer.renderer.rules.math_block_tex = (tokens: Array<{ content: string }>, index: number) => `${buildMathMarkup(tokens[index].content, true)}\n`;

const createTextNode = (documentRef: Document, className: string, text: string) => {
  const node = documentRef.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
};

const replaceNodeWithImageError = (image: HTMLImageElement, text: string) => {
  const errorNode = image.ownerDocument.createElement("span");
  errorNode.className = "markdown-image-error";
  errorNode.textContent = text;
  image.replaceWith(errorNode);
};

const wrapImageNode = (image: HTMLImageElement, altText: string) => {
  const existingWrapper = image.parentElement;
  if (existingWrapper?.classList.contains("markdown-image-wrap")) {
    const caption = existingWrapper.querySelector(".markdown-image-caption");
    if (!caption && altText) {
      existingWrapper.append(createTextNode(image.ownerDocument, "markdown-image-caption", altText));
    }
    return;
  }

  const wrapper = image.ownerDocument.createElement("span");
  wrapper.className = "markdown-image-wrap";
  image.replaceWith(wrapper);
  wrapper.append(image);
  if (altText) {
    wrapper.append(createTextNode(image.ownerDocument, "markdown-image-caption", altText));
  }
};

const replaceAnchorWithAttachmentCard = (anchor: HTMLAnchorElement, target: string, label: string) => {
  const documentRef = anchor.ownerDocument;
  const node = documentRef.createElement("div");
  node.className = "markdown-attachment-card";

  const ext = getFileName(target).split(".").pop()?.toUpperCase() ?? "FILE";
  node.append(createTextNode(documentRef, "markdown-attachment-card__badge", ext));

  const body = documentRef.createElement("span");
  body.className = "markdown-attachment-card__body";
  body.append(createTextNode(documentRef, "markdown-attachment-card__title", label));
  body.append(createTextNode(documentRef, "markdown-attachment-card__path", target));
  node.append(body);

  anchor.replaceWith(node);
};

const replaceAnchorWithStaticLink = (anchor: HTMLAnchorElement, label: string, target: string) => {
  const documentRef = anchor.ownerDocument;
  const node = documentRef.createElement("span");
  node.className = "markdown-static-link";
  node.append(createTextNode(documentRef, "markdown-static-link__text", label));
  node.append(createTextNode(documentRef, "markdown-static-link__target", target));
  anchor.replaceWith(node);
};

const sanitizeRoot = (root: HTMLElement) => {
  root.querySelectorAll("script, iframe, object, embed, frame, meta, base").forEach((node) => node.remove());

  root.querySelectorAll<HTMLElement>("*").forEach((element) => {
    for (const attribute of Array.from(element.getAttributeNames())) {
      if (attribute.toLowerCase().startsWith("on")) {
        element.removeAttribute(attribute);
      }
    }
  });
};

const normalizeAlignmentTags = (root: HTMLElement) => {
  for (const tagName of ALIGN_TAG_NAMES) {
    root.querySelectorAll(tagName).forEach((node) => {
      const replacement = node.ownerDocument.createElement("div");
      replacement.className = `markdown-align-block markdown-align-block--${tagName}`;
      replacement.dataset.align = tagName;
      replacement.innerHTML = node.innerHTML;
      node.replaceWith(replacement);
    });
  }
};

const normalizeAnchors = (root: HTMLElement, options: PrintEnhanceOptions) => {
  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    const rawHref = stripWrappingQuotes(anchor.getAttribute("href") ?? "");
    if (!rawHref || UNSAFE_PROTOCOL_RE.test(rawHref)) {
      anchor.removeAttribute("href");
      return;
    }

    const explicitAttachment =
      rawHref.toLowerCase().startsWith("attachment:") ||
      anchor.dataset.kind === "attachment" ||
      (anchor.getAttribute("title") ?? "").toLowerCase().includes("attachment");
    const normalizedHref = explicitAttachment ? rawHref.replace(/^attachment:/i, "") : rawHref;
    const label = anchor.textContent?.trim() || getFileName(normalizedHref) || normalizedHref;

    if (normalizedHref.startsWith("#")) return;

    if (explicitAttachment) {
      const resolvedAttachment = resolveDocumentTarget(normalizedHref, options.sourcePath) || sanitizeAssetString(normalizedHref);
      replaceAnchorWithAttachmentCard(anchor, resolvedAttachment, label);
      return;
    }

    if (EXTERNAL_PROTOCOL_RE.test(normalizedHref)) {
      replaceAnchorWithStaticLink(anchor, label, normalizedHref);
      return;
    }

    const resolvedLocalPath = resolveDocumentTarget(normalizedHref, options.sourcePath);
    replaceAnchorWithStaticLink(anchor, label, resolvedLocalPath || sanitizeAssetString(normalizedHref));
  });
};

const normalizeImages = async (root: HTMLElement, options: PrintEnhanceOptions) => {
  const images = Array.from(root.querySelectorAll("img"));

  for (const image of images) {
    const rawSrc = stripWrappingQuotes(image.getAttribute("src") ?? "");
    const altText = stripWrappingQuotes(image.getAttribute("alt") ?? "");
    const fallbackText = altText || rawSrc || (options.language === "en" ? "Image" : "Image");

    if (!rawSrc || UNSAFE_PROTOCOL_RE.test(rawSrc)) {
      replaceNodeWithImageError(image, fallbackText);
      continue;
    }

    const externalSource = EXTERNAL_PROTOCOL_RE.test(rawSrc) ? rawSrc : "";
    const localPath = externalSource ? "" : resolveDocumentTarget(rawSrc, options.sourcePath);

    image.classList.add("markdown-image");

    try {
      if (localPath) {
        image.src = await readLocalFileAsDataUrl(localPath, guessImageMimeType(localPath));
      } else if (externalSource.startsWith("http://") || externalSource.startsWith("https://")) {
        image.src = await fetchAsDataUrl(externalSource).catch(() => externalSource);
      } else if (externalSource) {
        image.src = externalSource;
      } else {
        replaceNodeWithImageError(image, fallbackText);
        continue;
      }
    } catch {
      replaceNodeWithImageError(image, fallbackText);
      continue;
    }

    wrapImageNode(image, altText);
  }
};

const typesetMath = (root: HTMLElement) => {
  const mathNodes = Array.from(root.querySelectorAll<HTMLElement>(".markdown-math"));
  if (mathNodes.length === 0) return;

  for (const node of mathNodes) {
    const source = decodeMathSource(node.dataset.mathSource ?? "");
    const displayMode = node.dataset.mathDisplay === "true";

    node.classList.remove("markdown-math-error");
    node.replaceChildren();

    try {
      node.innerHTML = katex.renderToString(source, {
        displayMode,
        throwOnError: false,
        strict: "ignore",
        trust: true,
        output: "htmlAndMathml"
      });
    } catch (error) {
      node.classList.add("markdown-math-error");
      node.textContent = source;
      console.error("Failed to typeset markdown math for print", error);
    }
  }
};

const createPrintDocumentRoot = (html: string) => {
  const documentRef = document.implementation.createHTMLDocument("print-export");
  const root = documentRef.createElement("div");
  root.className = "markdown-preview";
  root.innerHTML = html;
  documentRef.body.append(root);
  return root;
};

const getPathStem = (path: string) => {
  const fileName = getFileName(path);
  return fileName.replace(/\.[^.]+$/u, "").trim();
};

const stripInlineMarkdown = (value: string) =>
  value
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[_*~`#>]+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const resolveExportTitle = (
  markdown: string,
  language: "zh" | "en",
  meta?: PdfPrintDocumentMeta
) => {
  if (meta?.documentTitle?.trim()) return meta.documentTitle.trim();

  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index].trim();
    const headingMatch = currentLine.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch?.[1]) {
      const title = stripInlineMarkdown(headingMatch[1]);
      if (title) return title;
    }

    const nextLine = lines[index + 1]?.trim() ?? "";
    if (currentLine && /^(=+|-+)$/u.test(nextLine)) {
      const title = stripInlineMarkdown(currentLine);
      if (title) return title;
    }
  }

  if (meta?.documentPath?.trim()) {
    const stem = getPathStem(meta.documentPath.trim());
    if (stem) return stem;
  }

  return language === "en" ? "Markdown Notes Export" : "Markdown 笔记导出";
};

const slotHasMarginContent = (slot: PdfExportSlot) =>
  slot.kind !== "none" && !(slot.kind === "custom" && !slot.text.trim());

const slotMarginContentExpression = (slot: PdfExportSlot, title: string, dateText: string) => {
  switch (slot.kind) {
    case "title":
      return `"${escapeCssString(title)}"`;
    case "date":
      return `"${escapeCssString(dateText)}"`;
    case "pageNumber":
      return "counter(page)";
    case "pageNumberTotal":
      return 'counter(page) " / " counter(pages)';
    case "custom":
      return `"${escapeCssString(slot.text || "")}"`;
    default:
      return "none";
  }
};

const buildMarginBoxRule = (
  boxName: string,
  slot: PdfExportSlot,
  title: string,
  dateText: string
) => {
  if (!slotHasMarginContent(slot)) return `      ${boxName} { content: none; }`;
  return `      ${boxName} {
        content: ${slotMarginContentExpression(slot, title, dateText)};
        color: #475569;
        font-size: 8.5pt;
        font-family: "Palatino Linotype", "Book Antiqua", "Times New Roman", "Songti SC", "SimSun", serif;
        white-space: pre-wrap;
      }`;
};

const buildMarginBoxStyles = (settings: PdfExportSettings, title: string, dateText: string) => {
  const rules: string[] = [];

  if (settings.header.enabled) {
    rules.push(buildMarginBoxRule("@top-left", settings.header.left, title, dateText));
    rules.push(buildMarginBoxRule("@top-center", settings.header.center, title, dateText));
    rules.push(buildMarginBoxRule("@top-right", settings.header.right, title, dateText));
  }

  if (settings.footer.enabled) {
    rules.push(buildMarginBoxRule("@bottom-left", settings.footer.left, title, dateText));
    rules.push(buildMarginBoxRule("@bottom-center", settings.footer.center, title, dateText));
    rules.push(buildMarginBoxRule("@bottom-right", settings.footer.right, title, dateText));
  }

  return rules.join("\n");
};

const resolveNativePrintHeaderFooter = (
  _settings: PdfExportSettings,
  _title: string,
  _dateText: string
): NativePrintHeaderFooterOptions => {
  return {
    enabled: false,
    headerTitle: "",
    footerUri: ""
  };
};

const pageSizeCss = (settings: PdfExportSettings) => `${settings.pageSize} ${settings.landscape ? "landscape" : "portrait"}`;
const marginCss = (settings: PdfExportSettings) => `${settings.margins.top}mm ${settings.margins.right}mm ${settings.margins.bottom}mm ${settings.margins.left}mm`;

const pageDimensions = (settings: PdfExportSettings) => {
  const size = settings.pageSize === "Letter" ? { width: 215.9, height: 279.4 } : { width: 210, height: 297 };
  return settings.landscape ? { width: size.height, height: size.width } : size;
};

const buildPrintCss = async (settings: PdfExportSettings, title: string, dateText: string) => {
  const { width } = pageDimensions(settings);
  const embeddedKatexStyles = await getEmbeddedKatexStyles();
  const marginBoxStyles = buildMarginBoxStyles(settings, title, dateText);

  return `
    ${embeddedKatexStyles}
    :root { color-scheme: light; }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      color: #1f2937;
    }
    body {
      font-family: "Palatino Linotype", "Book Antiqua", "Times New Roman", "Songti SC", "SimSun", serif;
      text-rendering: geometricPrecision;
      line-height: 1.72;
      font-size: ${14 * settings.scale}px;
    }
    @page {
      size: ${pageSizeCss(settings)};
      margin: ${marginCss(settings)};
${marginBoxStyles}
    }
    .notes-export-shell {
      width: 100%;
      max-width: ${width - settings.margins.left - settings.margins.right}mm;
      margin: 0 auto;
    }
    .notes-export-document {
      widows: 2;
      orphans: 2;
    }
    .notes-export-document > :first-child { margin-top: 0; }
    .notes-export-document > :last-child { margin-bottom: 0; }
    .notes-export-document pre,
    .notes-export-document blockquote,
    .notes-export-document table,
    .notes-export-document img,
    .notes-export-document .markdown-image-wrap,
    .notes-export-document .markdown-attachment-card,
    .notes-export-document .markdown-math-display,
    .notes-export-document .pdf-quote-block,
    .notes-export-document h1,
    .notes-export-document h2,
    .notes-export-document h3,
    .notes-export-document h4 {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .notes-export-document img,
    .notes-export-document .markdown-image {
      max-width: 100%;
    }
    .notes-export-document table {
      width: 100%;
    }
    .pdf-quote-block {
      margin: 0.85rem 0;
      border-left: 4px solid #2563eb;
      border-radius: 12px;
      background: #f4f8ff;
      padding: 0.8rem 0.95rem;
    }
    .pdf-quote-header {
      margin-bottom: 0.5rem;
      color: #2563eb;
      font-size: 12px;
      font-weight: 700;
    }
    .markdown-preview {
      color: #1f2937;
      line-height: 1.72;
      font-size: inherit;
    }
    .markdown-preview h1,
    .markdown-preview h2,
    .markdown-preview h3 {
      margin: 0.85rem 0 0.55rem;
      line-height: 1.28;
      font-weight: 700;
      page-break-after: avoid;
    }
    .markdown-preview h1 { font-size: 1.58rem; }
    .markdown-preview h2 { font-size: 1.32rem; }
    .markdown-preview h3 { font-size: 1.15rem; }
    .markdown-preview p,
    .markdown-preview ul,
    .markdown-preview ol,
    .markdown-preview blockquote { margin: 0.58rem 0; }
    .markdown-preview blockquote:not(.pdf-quote-block) {
      border-left: 4px solid #c6d1df;
      border-radius: 0 14px 14px 0;
      background: #f3f6fb;
      padding: 0.82rem 1rem;
      color: #475569;
    }
    .markdown-preview blockquote:not(.pdf-quote-block) > :first-child { margin-top: 0; }
    .markdown-preview blockquote:not(.pdf-quote-block) > :last-child { margin-bottom: 0; }
    .markdown-align-block {
      display: block;
      width: 100%;
    }
    .markdown-align-block--center { text-align: center; }
    .markdown-align-block--left { text-align: left; }
    .markdown-align-block--right { text-align: right; }
    .markdown-static-link {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      align-items: baseline;
      color: #1d4ed8;
    }
    .markdown-static-link__target {
      color: #64748b;
      font-size: 0.85em;
      word-break: break-all;
    }
    .markdown-preview code {
      border-radius: 4px;
      background: #eef2f7;
      padding: 0.1rem 0.3rem;
      font-family: Consolas, "Courier New", monospace;
    }
    .markdown-preview pre,
    .markdown-code-block {
      overflow: auto;
      border-radius: 10px;
      background: #f8fafc;
      border: 1px solid #d9dde5;
      padding: 0.85rem 0.95rem;
      color: #1e293b;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .markdown-preview pre code {
      background: transparent;
      padding: 0;
      color: inherit;
    }
    .markdown-preview table {
      width: 100%;
      overflow: hidden;
      border-collapse: collapse;
      border: 1px solid #cfd8e3;
      border-radius: 10px;
      background: #fcfdff;
    }
    .markdown-preview thead { background: #eaf1fb; }
    .markdown-preview th,
    .markdown-preview td {
      border: 1px solid #cfd8e3;
      padding: 0.6rem 0.75rem;
      text-align: left;
      vertical-align: top;
    }
    .markdown-preview th {
      color: #1f2937;
      font-weight: 700;
    }
    .markdown-preview tbody tr:nth-child(even) { background: #f6f9fc; }
    .markdown-image-wrap {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      margin: 0.95rem 0;
      align-items: center;
    }
    .markdown-image {
      max-width: 100%;
      border: 1px solid #d9dde5;
      border-radius: 12px;
      background: #ffffff;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
    }
    .markdown-image-caption {
      color: #64748b;
      font-size: 12px;
      text-align: center;
    }
    .markdown-image-error {
      display: block;
      border: 1px dashed #cfd8e3;
      border-radius: 12px;
      background: #f8fafc;
      padding: 0.85rem 1rem;
      color: #64748b;
      font-size: 13px;
    }
    .markdown-math-inline {
      display: inline-block;
      max-width: 100%;
      vertical-align: middle;
    }
    .markdown-math-display {
      margin: 1.05rem 0;
      overflow-x: auto;
      text-align: center;
      padding: 0.1rem 0;
    }
    .markdown-math-inline .katex,
    .markdown-math-display .katex {
      font-size: 1.08em;
      line-height: 1.28;
    }
    .markdown-math-inline .katex {
      max-width: 100%;
    }
    .markdown-math-display .katex-display {
      margin: 0.2rem 0;
      overflow-x: auto;
      overflow-y: hidden;
    }
    .markdown-math-display .katex-display > .katex {
      white-space: nowrap;
    }
    .markdown-attachment-card {
      display: inline-flex;
      max-width: min(100%, 520px);
      align-items: center;
      gap: 0.8rem;
      border: 1px solid #d9dde5;
      border-radius: 14px;
      background: #f8fafc;
      padding: 0.75rem 0.95rem;
      color: #1f2937;
      text-align: left;
      box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08);
    }
    .markdown-attachment-card__badge {
      display: inline-flex;
      min-width: 3rem;
      justify-content: center;
      align-items: center;
      border-radius: 999px;
      background: #dbeafe;
      padding: 0.3rem 0.55rem;
      color: #1d4ed8;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
    }
    .markdown-attachment-card__body {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: 0.15rem;
    }
    .markdown-attachment-card__title {
      font-size: 13px;
      font-weight: 600;
      word-break: break-word;
    }
    .markdown-attachment-card__path {
      color: #64748b;
      font-size: 12px;
      word-break: break-all;
    }
  `;
};

const buildReadyScript = (manifest: PdfExportDebugManifest) => `
  <script id="pdf-export-debug" type="application/json">${escapeHtml(JSON.stringify(manifest))}</script>
  <script>
    (function () {
      var startedAt = Date.now();
      var status = {
        stage: "booting",
        ready: false,
        error: "",
        events: []
      };

      function writeStage(stage, detail) {
        status.stage = stage;
        status.events.push({
          stage: stage,
          detail: detail || "",
          atMs: Date.now() - startedAt
        });
      }

      function markError(error) {
        var message = String(error && error.message ? error.message : error || "");
        status.error = message;
        window.__PDF_EXPORT_ERROR__ = message;
        writeStage("error", message);
      }

      window.__PDF_EXPORT_STATUS__ = status;
      window.__PDF_EXPORT_READY__ = false;
      window.__PDF_EXPORT_ERROR__ = "";

      window.addEventListener("error", function (event) {
        markError(event.error || event.message || "Unknown window error");
      });

      window.addEventListener("unhandledrejection", function (event) {
        markError(event.reason || "Unhandled promise rejection");
      });

      function waitForImages() {
        var images = Array.prototype.slice.call(document.images || []);
        writeStage("images_found", "count=" + images.length);
        return Promise.all(
          images.map(function (image) {
            if (image.complete) {
              if (typeof image.decode === "function") {
                return image.decode().catch(function () {
                  return undefined;
                });
              }
              return Promise.resolve();
            }
            return new Promise(function (resolve) {
              var settled = false;
              var finish = function () {
                if (settled) return;
                settled = true;
                resolve(undefined);
              };
              image.addEventListener("load", finish, { once: true });
              image.addEventListener("error", finish, { once: true });
              setTimeout(finish, 4000);
            });
          })
        );
      }

      function waitForStableFrame() {
        return new Promise(function (resolve) {
          requestAnimationFrame(function () {
            requestAnimationFrame(resolve);
          });
        });
      }

      function runPagedPreview() {
        if (!window.PagedPolyfill || typeof window.PagedPolyfill.preview !== "function") {
          writeStage("paged_preview_skipped", "pagedjs-unavailable");
          return Promise.resolve();
        }

        writeStage("paged_preview_start", "preview");
        return Promise.resolve(window.PagedPolyfill.preview()).then(function (flow) {
          var total = flow && typeof flow.total !== "undefined" ? flow.total : "unknown";
          writeStage("paged_preview_done", "pages=" + total);
          return flow;
        });
      }

      Promise.resolve()
        .then(async function () {
          writeStage("document_loaded", document.readyState || "unknown");
          if (document.fonts && document.fonts.ready) {
            await document.fonts.ready;
          }
          writeStage("fonts_ready", "fonts-ready");
          await waitForImages();
          writeStage("images_ready", "images-stable");
          await runPagedPreview();
          if (document.fonts && document.fonts.ready) {
            await document.fonts.ready;
          }
          writeStage("paged_fonts_ready", "fonts-ready");
          await waitForImages();
          writeStage("paged_images_ready", "images-stable");
          await waitForStableFrame();
          writeStage("stable_frame_ready", "two-animation-frames");
          status.ready = true;
          window.__PDF_EXPORT_READY__ = true;
          writeStage("print_ready", "ready-for-native-print");
        })
        .catch(function (error) {
          markError(error);
          status.ready = true;
          window.__PDF_EXPORT_READY__ = true;
        });
    })();
  </script>
`;

const enhancePrintDocument = async (root: HTMLElement, options: PrintEnhanceOptions) => {
  sanitizeRoot(root);
  normalizeAlignmentTags(root);
  normalizeAnchors(root, options);
  await normalizeImages(root, options);
  typesetMath(root);
};

export const buildPdfPrintOptions = (
  settings: PdfExportSettings,
  markdown: string,
  language: "zh" | "en",
  meta?: PdfPrintDocumentMeta
) => {
  void markdown;
  void language;
  void meta;

  return {
    pageSize: settings.pageSize,
    landscape: settings.landscape,
    scale: settings.scale,
    margins: settings.margins
  };
};

export const buildMarkdownPdfExportHtml = async (
  markdown: string,
  language: "zh" | "en",
  settings: PdfExportSettings,
  meta?: PdfPrintDocumentMeta
) => {
  const title = resolveExportTitle(markdown, language, meta);
  const dateText = new Date().toLocaleDateString(language === "en" ? "en-US" : "zh-CN");
  const normalized = normalizeMarkdownDocument(markdown, { sourcePath: settings.sourcePath });
  const root = createPrintDocumentRoot(markdownRenderer.render(normalizeBlockDollarMath(normalized.markdown)));

  await enhancePrintDocument(root, {
    sourcePath: settings.sourcePath,
    language
  });

  const debugManifest: PdfExportDebugManifest = {
    createdAt: new Date().toISOString(),
    language,
    sourcePath: settings.sourcePath,
    pageSize: settings.pageSize,
    landscape: settings.landscape,
    margins: settings.margins,
    scale: settings.scale,
    title,
    resourceCount: normalized.resources.length,
    resources: normalized.resources
  };

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      ${await buildPrintCss(settings, title, dateText)}
    </style>
  </head>
  <body>
    <main class="notes-export-shell markdown-preview">
      <article class="notes-export-document">
        ${root.innerHTML}
      </article>
    </main>
    <script>window.PagedConfig = { auto: false };</script>
    <script>${await getEmbeddedPagedJsSource()}</script>
    ${buildReadyScript(debugManifest)}
  </body>
</html>`;
};
