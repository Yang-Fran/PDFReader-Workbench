import { MouseEvent, UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Prec } from "@codemirror/state";
import type { Text } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { MarkdownPreview } from "../markdown/MarkdownPreview";
import { nativeFileService } from "../../services/nativeFileService";
import { useAppStore } from "../../stores/appStore";
import { useToastStore } from "../../stores/toastStore";
import { t } from "../../i18n";
import { buildMarkdownPdfExportHtml, buildPdfPrintOptions } from "../../services/markdownPrintService";
import { formatUiError, withTimeout } from "../../utils/textDisplay";

const buildPdfQuoteMarkdown = (quote: { text: string; page: number; pdfPath: string; pdfName: string }) => {
  const meta = JSON.stringify({ name: quote.pdfName, page: quote.page, path: quote.pdfPath });
  return `\`\`\`pdf-quote\n${meta}\n${quote.text.trim()}\n\`\`\``;
};

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif"
};

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i;

const normalizePath = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^[a-zA-Z]:/);
  const prefix = driveMatch ? driveMatch[0] : normalized.startsWith("/") ? "/" : "";
  const body = prefix === "/" ? normalized.slice(1) : driveMatch ? normalized.slice(prefix.length).replace(/^\/+/u, "") : normalized;
  const next: string[] = [];

  for (const segment of body.split("/").filter(Boolean)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (next.length > 0) next.pop();
      continue;
    }
    next.push(segment);
  }

  if (prefix === "/") return `/${next.join("/")}`;
  return prefix ? `${prefix}/${next.join("/")}` : next.join("/");
};

const getDirname = (path: string) => {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : normalized;
};

const splitNormalizedPath = (path: string) => {
  const normalized = normalizePath(path);
  const driveMatch = normalized.match(/^[a-zA-Z]:/);
  const prefix = driveMatch ? driveMatch[0] : normalized.startsWith("/") ? "/" : "";
  const body = prefix === "/" ? normalized.slice(1) : driveMatch ? normalized.slice(prefix.length).replace(/^\/+/u, "") : normalized;
  return {
    prefix,
    segments: body.split("/").filter(Boolean)
  };
};

const getRelativePath = (fromDir: string, toPath: string) => {
  const from = splitNormalizedPath(fromDir);
  const to = splitNormalizedPath(toPath);

  if (from.prefix.toLowerCase() !== to.prefix.toLowerCase()) {
    return normalizePath(toPath);
  }

  let sharedIndex = 0;
  while (
    sharedIndex < from.segments.length &&
    sharedIndex < to.segments.length &&
    from.segments[sharedIndex].toLowerCase() === to.segments[sharedIndex].toLowerCase()
  ) {
    sharedIndex += 1;
  }

  const relativeSegments = [
    ...new Array(from.segments.length - sharedIndex).fill(".."),
    ...to.segments.slice(sharedIndex)
  ];

  return relativeSegments.join("/") || ".";
};

const sanitizeFileStem = (value: string) =>
  value
    .replace(/\.[^.]+$/u, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "pasted-image";

const guessImageExtension = (file: Pick<File, "name" | "type">) => {
  const byName = file.name.match(IMAGE_EXTENSION_RE)?.[0]?.toLowerCase();
  if (byName) return byName === ".jpeg" ? ".jpg" : byName;
  return IMAGE_EXTENSION_BY_MIME[file.type.toLowerCase()] ?? ".png";
};

const buildPastedImageFileName = (file: Pick<File, "name" | "type">, index: number) => {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `${sanitizeFileStem(file.name)}-${stamp}-${index + 1}-${randomSuffix}${guessImageExtension(file)}`;
};

const buildImageAltText = (fileName: string) => sanitizeFileStem(fileName).replace(/-/g, " ");

const extractClipboardImageFiles = (clipboardData: DataTransfer | null) => {
  if (!clipboardData) return [] as File[];

  const itemFiles = Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file && (file.type.startsWith("image/") || IMAGE_EXTENSION_RE.test(file.name)));

  if (itemFiles.length > 0) return itemFiles;

  return Array.from(clipboardData.files).filter((file) => file.type.startsWith("image/") || IMAGE_EXTENSION_RE.test(file.name));
};

const insertIntoCodeMirror = (view: EditorView, value: string) => {
  if (!value) return;
  const selection = view.state.selection.main;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: value },
    selection: { anchor: selection.from + value.length },
    userEvent: "input.paste"
  });
  view.focus();
};

type InlineFormatKey = "bold" | "italic" | "underline";
type InlineFormatState = Record<InlineFormatKey, boolean>;

const UNDERLINE_MARKER = { open: "<u>", close: "</u>" } as const;
const INLINE_FORMAT_MARKERS: Record<InlineFormatKey, { open: string; close: string }> = {
  bold: { open: "**", close: "**" },
  italic: { open: "*", close: "*" },
  underline: UNDERLINE_MARKER
};
const INLINE_FORMAT_ORDER: InlineFormatKey[] = ["underline", "bold", "italic"];

const createInlineFormatState = (): InlineFormatState => ({
  bold: false,
  italic: false,
  underline: false
});

const resolveInlineFormatKey = (open: string, close: string): InlineFormatKey | null =>
  (Object.entries(INLINE_FORMAT_MARKERS).find(([, marker]) => marker.open === open && marker.close === close)?.[0] as InlineFormatKey | undefined) ?? null;

const countStringCharRun = (value: string, start: number, direction: -1 | 1, char: string, limit = 3) => {
  let count = 0;
  while (count < limit) {
    const index = direction === -1 ? start - count - 1 : start + count;
    if (index < 0 || index >= value.length || value[index] !== char) break;
    count += 1;
  }
  return count;
};

const countDocCharRun = (doc: Text, start: number, direction: -1 | 1, char: string, limit = 3) => {
  let count = 0;
  while (count < limit) {
    const index = direction === -1 ? start - count - 1 : start + count;
    if (index < 0 || index >= doc.length || doc.sliceString(index, index + 1) !== char) break;
    count += 1;
  }
  return count;
};

const expandInlineFormatRange = (doc: Text, from: number, to: number) => {
  let nextFrom = from;
  let nextTo = to;
  let changed = true;

  while (changed) {
    changed = false;

    if (
      nextFrom >= UNDERLINE_MARKER.open.length &&
      nextTo + UNDERLINE_MARKER.close.length <= doc.length &&
      doc.sliceString(nextFrom - UNDERLINE_MARKER.open.length, nextFrom) === UNDERLINE_MARKER.open &&
      doc.sliceString(nextTo, nextTo + UNDERLINE_MARKER.close.length) === UNDERLINE_MARKER.close
    ) {
      nextFrom -= UNDERLINE_MARKER.open.length;
      nextTo += UNDERLINE_MARKER.close.length;
      changed = true;
      continue;
    }

    const sharedStars = Math.min(countDocCharRun(doc, nextFrom, -1, "*"), countDocCharRun(doc, nextTo, 1, "*"));
    if (sharedStars > 0) {
      nextFrom -= sharedStars;
      nextTo += sharedStars;
      changed = true;
    }
  }

  return { from: nextFrom, to: nextTo };
};

const extractInlineFormats = (value: string) => {
  let nextValue = value;
  const formats = createInlineFormatState();
  let changed = true;

  while (changed && nextValue.length > 0) {
    changed = false;

    if (
      nextValue.startsWith(UNDERLINE_MARKER.open) &&
      nextValue.endsWith(UNDERLINE_MARKER.close) &&
      nextValue.length >= UNDERLINE_MARKER.open.length + UNDERLINE_MARKER.close.length
    ) {
      formats.underline = true;
      nextValue = nextValue.slice(UNDERLINE_MARKER.open.length, nextValue.length - UNDERLINE_MARKER.close.length);
      changed = true;
      continue;
    }

    const sharedStars = Math.min(countStringCharRun(nextValue, 0, 1, "*"), countStringCharRun(nextValue, nextValue.length, -1, "*"));
    if (sharedStars >= 2) {
      formats.bold = true;
      nextValue = nextValue.slice(2, nextValue.length - 2);
      changed = true;
      continue;
    }
    if (sharedStars >= 1) {
      formats.italic = true;
      nextValue = nextValue.slice(1, nextValue.length - 1);
      changed = true;
    }
  }

  return { text: nextValue, formats };
};

const buildInlineFormatText = (value: string, formats: InlineFormatState) => {
  let prefix = "";
  let suffix = "";

  for (const key of INLINE_FORMAT_ORDER) {
    if (!formats[key]) continue;
    prefix += INLINE_FORMAT_MARKERS[key].open;
    suffix = `${INLINE_FORMAT_MARKERS[key].close}${suffix}`;
  }

  return {
    value: `${prefix}${value}${suffix}`,
    selectionStart: prefix.length,
    selectionEnd: prefix.length + value.length
  };
};

const wrapEditorSelection = (view: EditorView, open: string, close: string) => {
  const targetFormat = resolveInlineFormatKey(open, close);
  if (!targetFormat) return false;

  const replaceSelection = (from: number, to: number, insert: string, selectFrom: number, selectTo = selectFrom) => {
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: selectFrom, head: selectTo },
      userEvent: "input"
    });
    view.focus();
    return true;
  };

  const selection = view.state.selection.main;
  const hasSelection = selection.from !== selection.to;
  const range = hasSelection ? expandInlineFormatRange(view.state.doc, selection.from, selection.to) : { from: selection.from, to: selection.to };
  const selectedText = view.state.sliceDoc(range.from, range.to);
  const { text, formats } = extractInlineFormats(selectedText);
  const nextText = buildInlineFormatText(text, {
    ...formats,
    [targetFormat]: !formats[targetFormat]
  });

  return replaceSelection(
    range.from,
    range.to,
    nextText.value,
    range.from + nextText.selectionStart,
    range.from + nextText.selectionEnd
  );
};

const normalizeSyncText = (value: string) =>
  value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*]\(([^)\n]+)\)/g, " ")
    .replace(/\[([^\]]+)]\(([^)\n]+)\)/g, "$1")
    .replace(/\\\(|\\\)|\\\[|\\\]/g, " ")
    .replace(/\$+/g, " ")
    .replace(/[#>*_~|[\]()`!-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const scoreSyncText = (source: string, query: string) => {
  if (!source || !query) return -1;
  if (source === query) return 5000 + query.length;
  if (source.includes(query)) return 4000 + query.length;
  if (query.includes(source) && source.length >= 6) return 2600 + source.length;

  const queryParts = query.split(" ").filter((part) => part.length >= 2);
  let overlap = 0;
  for (const part of queryParts) {
    if (source.includes(part)) overlap += Math.min(part.length, 16);
  }
  return overlap;
};

const focusEditorWithoutPageScroll = (editorView: EditorView) => {
  editorView.contentDOM.focus({ preventScroll: true });
};

const scrollPreviewBlockIntoView = (container: HTMLDivElement, element: HTMLElement) => {
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const targetScroll =
    container.scrollTop +
    (elementRect.top - containerRect.top) -
    container.clientHeight / 2 +
    element.clientHeight / 2;

  container.scrollTo({
    top: Math.max(0, Math.min(targetScroll, container.scrollHeight - container.clientHeight)),
    behavior: "smooth"
  });
};

const parsePreviewSourceLine = (element: HTMLElement, key: "mdSourceStart" | "mdSourceEnd") => {
  const value = Number.parseInt(element.dataset[key] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const findPreviewBlockBySourceLine = (container: HTMLDivElement, line: number) => {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>("[data-md-block='1']"));
  let bestMatch: { element: HTMLElement; distance: number; span: number; contains: boolean } | null = null;

  for (const element of blocks) {
    const startLine = parsePreviewSourceLine(element, "mdSourceStart");
    if (!startLine) continue;

    const endLine = parsePreviewSourceLine(element, "mdSourceEnd") ?? startLine;
    const contains = line >= startLine && line <= endLine;
    const distance = contains ? 0 : line < startLine ? startLine - line : line - endLine;
    const span = Math.max(0, endLine - startLine);

    if (
      !bestMatch ||
      (contains && !bestMatch.contains) ||
      (contains === bestMatch.contains && (distance < bestMatch.distance || (distance === bestMatch.distance && span < bestMatch.span)))
    ) {
      bestMatch = { element, distance, span, contains };
    }
  }

  return bestMatch?.element ?? null;
};

export function NotesPane() {
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [exportBusy, setExportBusy] = useState(false);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const editorRestorePendingRef = useRef(true);
  const previewRestorePendingRef = useRef(true);
  const savedNotesViewStateRef = useRef(useAppStore.getState().notesViewState);
  const editorScrollTopRef = useRef(savedNotesViewStateRef.current.editorScrollTop);
  const previewScrollTopRef = useRef(savedNotesViewStateRef.current.previewScrollTop);
  const selectionAnchorRef = useRef(savedNotesViewStateRef.current.selectionAnchor);

  const notes = useAppStore((state) => state.notes);
  const setNotes = useAppStore((state) => state.setNotes);
  const appendToNotes = useAppStore((state) => state.appendToNotes);
  const selectedPdfText = useAppStore((state) => state.selectedPdfText);
  const selectedPdfQuote = useAppStore((state) => state.selectedPdfQuote);
  const setSelectedPdfQuote = useAppStore((state) => state.setSelectedPdfQuote);
  const lastAIReply = useAppStore((state) => state.lastAIReply);
  const requestPdfOpen = useAppStore((state) => state.requestPdfOpen);
  const projectPath = useAppStore((state) => state.projectPath);
  const notesFilePath = useAppStore((state) => state.notesFilePath);
  const language = useAppStore((state) => state.settings.language);
  const pdfExport = useAppStore((state) => state.settings.pdfExport);
  const setSettings = useAppStore((state) => state.setSettings);
  const pushToast = useToastStore((state) => state.pushToast);
  const markdownDocumentPath = notesFilePath || projectPath || "";

  const markdownAssetBase = useMemo(() => {
    if (!markdownDocumentPath) return "";
    return getDirname(markdownDocumentPath);
  }, [markdownDocumentPath]);

  const imageCacheBase = useMemo(() => {
    if (projectPath) return getDirname(projectPath);
    if (notesFilePath) return getDirname(notesFilePath);
    return "";
  }, [notesFilePath, projectPath]);

  useEffect(() => {
    if (pdfExport.sourcePath === markdownDocumentPath) return;
    setSettings({
      pdfExport: {
        ...pdfExport,
        sourcePath: markdownDocumentPath
      }
    });
  }, [markdownDocumentPath, pdfExport, setSettings]);

  const captureNotesViewState = useCallback(() => {
    const nextState = {
      editorScrollTop: editorView ? editorView.scrollDOM.scrollTop : editorScrollTopRef.current,
      previewScrollTop: previewScrollRef.current?.scrollTop ?? previewScrollTopRef.current,
      selectionAnchor: editorView ? editorView.state.selection.main.head : selectionAnchorRef.current
    };

    editorScrollTopRef.current = nextState.editorScrollTop;
    previewScrollTopRef.current = nextState.previewScrollTop;
    selectionAnchorRef.current = nextState.selectionAnchor;
    useAppStore.getState().setNotesViewState(nextState);
  }, [editorView]);

  const editorHighlightExtension = useMemo(
    () =>
      syntaxHighlighting(
        HighlightStyle.define([
          { tag: [tags.processingInstruction, tags.meta, tags.special(tags.string)], color: "var(--code-block-text)" },
          { tag: [tags.monospace, tags.content], color: "var(--code-block-text)" },
          { tag: [tags.string, tags.labelName], color: "color-mix(in srgb, var(--code-block-text) 92%, var(--text-main))" },
          { tag: [tags.heading], color: "var(--text-main)" }
        ])
      ),
    []
  );

  const syncPreviewToEditor = () => {
    if (!editorView || !previewScrollRef.current) return;

    const currentLineNumber = editorView.state.doc.lineAt(editorView.state.selection.main.head).number;
    const mappedBlock = findPreviewBlockBySourceLine(previewScrollRef.current, currentLineNumber);
    if (mappedBlock) {
      scrollPreviewBlockIntoView(previewScrollRef.current, mappedBlock);
      return;
    }

    const docLines = editorView.state.doc.toString().split("\n");
    const windowQueries = [
      docLines[currentLineNumber - 1] ?? "",
      [docLines[currentLineNumber - 2] ?? "", docLines[currentLineNumber - 1] ?? ""].join(" "),
      [docLines[currentLineNumber - 1] ?? "", docLines[currentLineNumber] ?? ""].join(" "),
      [docLines[currentLineNumber - 2] ?? "", docLines[currentLineNumber - 1] ?? "", docLines[currentLineNumber] ?? ""].join(" ")
    ]
      .map(normalizeSyncText)
      .filter((value, index, array) => value.length >= 2 && array.indexOf(value) === index)
      .sort((left, right) => right.length - left.length);

    if (windowQueries.length === 0) return;

    const blocks = Array.from(previewScrollRef.current.querySelectorAll<HTMLElement>("[data-md-block='1']"));
    let bestMatch: { element: HTMLElement; score: number } | null = null;

    for (const element of blocks) {
      const blockText = normalizeSyncText(element.textContent ?? "");
      if (!blockText) continue;
      const score = windowQueries.reduce((best, query) => Math.max(best, scoreSyncText(blockText, query)), -1);
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { element, score };
      }
    }

    if (!bestMatch || bestMatch.score < 6) return;

    scrollPreviewBlockIntoView(previewScrollRef.current, bestMatch.element);
  };

  const syncEditorToPreview = (event: MouseEvent<HTMLDivElement>) => {
    if (!editorView || !previewScrollRef.current) return;

    const block = (event.target as HTMLElement | null)?.closest?.("[data-md-block='1']") as HTMLElement | null;
    if (!block || !previewScrollRef.current.contains(block)) return;

    const mappedLine = parsePreviewSourceLine(block, "mdSourceStart");
    if (mappedLine) {
      const targetLine = Math.min(mappedLine, editorView.state.doc.lines);
      const position = editorView.state.doc.line(targetLine).from;
      editorView.dispatch({
        selection: { anchor: position },
        effects: EditorView.scrollIntoView(position, { y: "center" })
      });
      focusEditorWithoutPageScroll(editorView);
      return;
    }

    const snippet = normalizeSyncText(block.textContent ?? "");
    if (!snippet) return;

    const docLines = editorView.state.doc.toString().split("\n");
    let bestLine = -1;
    let bestScore = -1;

    for (let index = 0; index < docLines.length; index += 1) {
      const lineText = normalizeSyncText(docLines[index] ?? "");
      const windowText = normalizeSyncText([docLines[index] ?? "", docLines[index + 1] ?? "", docLines[index + 2] ?? ""].join(" "));
      const score = Math.max(scoreSyncText(lineText, snippet), scoreSyncText(windowText, snippet));
      if (score > bestScore) {
        bestScore = score;
        bestLine = index + 1;
      }
    }

    if (bestLine < 1 || bestScore < 6) return;

    const position = editorView.state.doc.line(bestLine).from;
    editorView.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: "center" })
    });
    focusEditorWithoutPageScroll(editorView);
  };

  const insertIntoEditor = useCallback(
    (value: string) => {
      if (!value) return;
      if (!editorView) {
        appendToNotes(value);
        return;
      }

      insertIntoCodeMirror(editorView, value);
    },
    [appendToNotes, editorView]
  );

  const insertPastedImages = useCallback(
    async (files: File[], targetView?: EditorView | null) => {
      if (files.length === 0) return false;

      const notesBaseDir = markdownAssetBase || imageCacheBase;
      if (!imageCacheBase || !notesBaseDir) {
        pushToast(
          language === "en" ? "Save the project or notes file before pasting images into Markdown." : "请先保存项目或笔记文件，再把图片粘贴到 Markdown。",
          "error"
        );
        return true;
      }

      try {
        const snippets: string[] = [];

        for (let index = 0; index < files.length; index += 1) {
          const file = files[index];
          const imagePath = normalizePath(`${imageCacheBase}/pic_cache/${buildPastedImageFileName(file, index)}`);
          const relativeTarget = getRelativePath(notesBaseDir, imagePath);
          const markdownTarget = relativeTarget === "." ? imagePath : relativeTarget;
          const altText = buildImageAltText(file.name || imagePath.split("/").pop() || "pasted-image");
          const bytes = new Uint8Array(await file.arrayBuffer());

          await nativeFileService.writeBinaryFile(imagePath, bytes);
          snippets.push(`![${altText}](${markdownTarget})`);
        }

        const insertValue = snippets.join("\n\n");
        if (targetView) {
          insertIntoCodeMirror(targetView, insertValue);
        } else {
          insertIntoEditor(insertValue);
        }
        return true;
      } catch (error) {
        console.error("Failed to paste images into markdown", error);
        pushToast(formatUiError(error, language), "error");
        return true;
      }
    },
    [imageCacheBase, insertIntoEditor, language, markdownAssetBase, pushToast]
  );

  const editorShortcutExtension = useMemo(
    () =>
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (event, view) => {
            const isModifier = event.ctrlKey || event.metaKey;
            if (!isModifier || event.altKey) return false;

            const key = event.code.startsWith("Key") ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
            if (key === "b") {
              event.preventDefault();
              event.stopPropagation();
              return wrapEditorSelection(view, "**", "**");
            }
            if (key === "i") {
              event.preventDefault();
              event.stopPropagation();
              return wrapEditorSelection(view, "*", "*");
            }
            if (key === "u") {
              event.preventDefault();
              event.stopPropagation();
              return wrapEditorSelection(view, "<u>", "</u>");
            }

            return false;
          }
        })
      ),
    []
  );

  const editorPasteExtension = useMemo(
    () =>
      EditorView.domEventHandlers({
        paste: (event, view) => {
          const files = extractClipboardImageFiles(event.clipboardData);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertPastedImages(files, view);
          return true;
        }
      }),
    [insertPastedImages]
  );

  const editorViewportExtension = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        editorScrollTopRef.current = update.view.scrollDOM.scrollTop;
        selectionAnchorRef.current = update.state.selection.main.head;
      }),
    []
  );

  const handlePreviewScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    previewScrollTopRef.current = event.currentTarget.scrollTop;
  }, []);

  const exportNotesPdf = async () => {
    const defaultBase =
      (notesFilePath || projectPath || "notes")
        .replace(/\.[^.]+$/i, "")
        .replace(/[\\/]+/g, "/")
        .split("/")
        .filter(Boolean)
        .pop() || "notes";
    const outputPath = await save({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      defaultPath: `${defaultBase}.pdf`
    });
    if (!outputPath) return;

    setExportBusy(true);
    try {
      const exportMarkdown = notes || t(language, "writeHere");
      const exportSettings = { ...pdfExport, sourcePath: markdownDocumentPath };
      const exportMeta = {
        documentPath: notesFilePath || projectPath || ""
      };
      const html = await withTimeout(
        buildMarkdownPdfExportHtml(exportMarkdown, language, exportSettings, exportMeta),
        15000,
        language === "en" ? "Building the PDF document timed out after 15s." : "PDF 导出文档构建在 15 秒后超时。"
      );
      await withTimeout(
        invoke("export_markdown_pdf", { html, outputPath, options: buildPdfPrintOptions(exportSettings, exportMarkdown, language, exportMeta) }),
        90000,
        language === "en" ? "PDF export timed out after 90s." : "PDF 导出超过 90 秒仍未返回。"
      );
      pushToast(language === "en" ? "PDF exported." : "PDF 已导出。", "success");
    } catch (error) {
      console.error("Failed to export markdown PDF", error);
      pushToast(formatUiError(error, language), "error");
    } finally {
      setExportBusy(false);
    }
  };

  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: string }>).detail;
      if (detail?.target === "md") {
        setRefreshTick((value) => value + 1);
      }
    };
    window.addEventListener("agent:refresh", onRefresh as EventListener);
    return () => window.removeEventListener("agent:refresh", onRefresh as EventListener);
  }, []);

  useEffect(() => {
    const onExportPdf = () => {
      if (!exportBusy) {
        void exportNotesPdf();
      }
    };
    window.addEventListener("app:export-pdf", onExportPdf as EventListener);
    return () => window.removeEventListener("app:export-pdf", onExportPdf as EventListener);
  }, [exportBusy, exportNotesPdf]);

  useEffect(() => {
    const onCollectProjectState = () => {
      captureNotesViewState();
    };
    window.addEventListener("app:collect-project-state", onCollectProjectState as EventListener);
    return () => window.removeEventListener("app:collect-project-state", onCollectProjectState as EventListener);
  }, [captureNotesViewState]);

  useEffect(() => {
    const nextViewState = useAppStore.getState().notesViewState;
    savedNotesViewStateRef.current = nextViewState;
    editorScrollTopRef.current = nextViewState.editorScrollTop;
    previewScrollTopRef.current = nextViewState.previewScrollTop;
    selectionAnchorRef.current = nextViewState.selectionAnchor;
    editorRestorePendingRef.current = true;
    previewRestorePendingRef.current = true;
  }, [notesFilePath, projectPath, refreshTick]);

  useEffect(() => {
    if (!editorView || !editorRestorePendingRef.current) return;

    let frame1 = 0;
    let frame2 = 0;
    frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        const targetAnchor = Math.max(0, Math.min(savedNotesViewStateRef.current.selectionAnchor, editorView.state.doc.length));
        const targetScrollTop = Math.max(0, savedNotesViewStateRef.current.editorScrollTop);
        if (editorView.state.selection.main.head !== targetAnchor) {
          editorView.dispatch({ selection: { anchor: targetAnchor } });
        }
        if (Math.abs(editorView.scrollDOM.scrollTop - targetScrollTop) > 1) {
          editorView.scrollDOM.scrollTop = targetScrollTop;
        }
        editorScrollTopRef.current = targetScrollTop;
        selectionAnchorRef.current = targetAnchor;
        editorRestorePendingRef.current = false;
      });
    });

    return () => {
      cancelAnimationFrame(frame1);
      cancelAnimationFrame(frame2);
    };
  }, [editorView, notesFilePath, projectPath, refreshTick]);

  useEffect(() => {
    if (!previewScrollRef.current || !previewRestorePendingRef.current) return;

    let frame = 0;
    let attempts = 0;
    const maxAttempts = 24;
    const restore = () => {
      const container = previewScrollRef.current;
      if (!container) return;

      attempts += 1;
      const targetScrollTop = Math.max(0, savedNotesViewStateRef.current.previewScrollTop);
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const nextScrollTop = Math.min(targetScrollTop, maxScrollTop);

      container.scrollTop = nextScrollTop;
      previewScrollTopRef.current = nextScrollTop;

      const reachedTarget = Math.abs(container.scrollTop - targetScrollTop) <= 1;
      const exhaustedRange = targetScrollTop <= maxScrollTop + 1;
      if (reachedTarget || exhaustedRange || attempts >= maxAttempts) {
        previewRestorePendingRef.current = false;
        return;
      }

      frame = requestAnimationFrame(restore);
    };
    frame = requestAnimationFrame(restore);

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [notes, notesFilePath, projectPath, refreshTick]);

  return (
    <section className="app-panel flex h-full flex-col rounded border border-border">
      <header className="app-section-header flex items-center justify-between border-b border-border p-2">
        <div>
          <div className="text-sm font-semibold">{t(language, "markdown")}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50" onClick={() => insertIntoEditor(selectedPdfText)} disabled={!selectedPdfText}>
            {t(language, "insertSelection")}
          </button>
          <button
            className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
            onClick={() => {
              if (!selectedPdfQuote) return;
              insertIntoEditor(buildPdfQuoteMarkdown(selectedPdfQuote));
              setSelectedPdfQuote(null);
            }}
            disabled={!selectedPdfQuote?.text}
          >
            {t(language, "insertQuote")}
          </button>
          <button className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50" onClick={() => insertIntoEditor(lastAIReply)} disabled={!lastAIReply}>
            {t(language, "insertAiReply")}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 p-2">
        <PanelGroup direction="vertical" className="h-full min-h-0">
          <Panel defaultSize={56} minSize={20}>
            <div className="app-card h-full min-h-0 overflow-hidden rounded border border-border" onDoubleClick={syncPreviewToEditor}>
              <CodeMirror
                key={`editor-${refreshTick}`}
                className="notes-editor"
                value={notes}
                height="100%"
                extensions={[markdown({ completeHTMLTags: false }), editorHighlightExtension, editorShortcutExtension, editorPasteExtension, editorViewportExtension, EditorView.lineWrapping]}
                onChange={(value) => setNotes(value)}
                onCreateEditor={(view) => {
                  editorRestorePendingRef.current = true;
                  editorScrollTopRef.current = view.scrollDOM.scrollTop;
                  selectionAnchorRef.current = view.state.selection.main.head;
                  setEditorView(view);
                }}
                basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: false }}
              />
            </div>
          </Panel>

          <PanelResizeHandle className="resize-handle-y" />

          <Panel defaultSize={44} minSize={20}>
            <div ref={previewScrollRef} className="app-card h-full overflow-auto rounded border border-border p-3" onDoubleClick={syncEditorToPreview} onScroll={handlePreviewScroll}>
              <div className="mb-2 text-xs font-semibold text-slate-500">{t(language, "preview")}</div>
              <article key={`preview-${refreshTick}`}>
                <MarkdownPreview
                  content={notes}
                  placeholder={t(language, "writeHere")}
                  sourcePath={markdownDocumentPath}
                  language={language}
                  onOpenPdfQuote={(path, page) => requestPdfOpen(path, { preserveState: true, targetPage: page })}
                />
              </article>
            </div>
          </Panel>
        </PanelGroup>
      </div>
    </section>
  );
}
