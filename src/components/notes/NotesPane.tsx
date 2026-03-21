import { MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { MarkdownPreview } from "../markdown/MarkdownPreview";
import { useAppStore } from "../../stores/appStore";
import { useToastStore } from "../../stores/toastStore";
import { t } from "../../i18n";
import { buildMarkdownPdfExportHtml, buildPdfPrintOptions } from "../../services/markdownPrintService";
import { formatUiError, withTimeout } from "../../utils/textDisplay";

const buildPdfQuoteMarkdown = (quote: { text: string; page: number; pdfPath: string; pdfName: string }) => {
  const meta = JSON.stringify({ name: quote.pdfName, page: quote.page, path: quote.pdfPath });
  return `\`\`\`pdf-quote\n${meta}\n${quote.text.trim()}\n\`\`\``;
};

const getDirname = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : normalized;
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

export function NotesPane() {
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [exportBusy, setExportBusy] = useState(false);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);

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

  const markdownAssetBase = useMemo(() => {
    if (notesFilePath) return getDirname(notesFilePath);
    if (projectPath) return getDirname(projectPath);
    return "";
  }, [notesFilePath, projectPath]);

  useEffect(() => {
    if (pdfExport.sourcePath === markdownAssetBase) return;
    setSettings({
      pdfExport: {
        ...pdfExport,
        sourcePath: markdownAssetBase
      }
    });
  }, [markdownAssetBase, pdfExport, setSettings]);

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

    const docLines = editorView.state.doc.toString().split("\n");
    const currentLineNumber = editorView.state.doc.lineAt(editorView.state.selection.main.head).number;
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

    const container = previewScrollRef.current;
    const elementRect = bestMatch.element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const targetScroll =
      container.scrollTop +
      (elementRect.top - containerRect.top) -
      container.clientHeight / 2 +
      bestMatch.element.clientHeight / 2;

    container.scrollTo({
      top: Math.max(0, Math.min(targetScroll, container.scrollHeight - container.clientHeight)),
      behavior: "smooth"
    });
  };

  const syncEditorToPreview = (event: MouseEvent<HTMLDivElement>) => {
    if (!editorView || !previewScrollRef.current) return;

    const block = (event.target as HTMLElement | null)?.closest?.("[data-md-block='1']") as HTMLElement | null;
    if (!block || !previewScrollRef.current.contains(block)) return;

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

  const insertIntoEditor = (value: string) => {
    if (!value) return;
    if (!editorView) {
      appendToNotes(value);
      return;
    }

    const selection = editorView.state.selection.main;
    editorView.dispatch({
      changes: { from: selection.from, to: selection.to, insert: value },
      selection: { anchor: selection.from + value.length }
    });
    editorView.focus();
  };

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
      const exportSettings = { ...pdfExport, sourcePath: markdownAssetBase };
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
                extensions={[markdown({ completeHTMLTags: false }), editorHighlightExtension, EditorView.lineWrapping]}
                onChange={(value) => setNotes(value)}
                onCreateEditor={(view) => setEditorView(view)}
                basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: false }}
              />
            </div>
          </Panel>

          <PanelResizeHandle className="resize-handle-y" />

          <Panel defaultSize={44} minSize={20}>
            <div ref={previewScrollRef} className="app-card h-full overflow-auto rounded border border-border p-3" onDoubleClick={syncEditorToPreview}>
              <div className="mb-2 text-xs font-semibold text-slate-500">{t(language, "preview")}</div>
              <article key={`preview-${refreshTick}`}>
                <MarkdownPreview
                  content={notes}
                  placeholder={t(language, "writeHere")}
                  sourcePath={markdownAssetBase}
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
