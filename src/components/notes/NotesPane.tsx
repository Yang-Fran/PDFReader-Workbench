import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useAppStore } from "../../stores/appStore";
import { t } from "../../i18n";

type QuoteMeta = {
  name: string;
  page: number;
  path: string;
};

const buildPdfQuoteMarkdown = (quote: { text: string; page: number; pdfPath: string; pdfName: string }) => {
  const meta = JSON.stringify({ name: quote.pdfName, page: quote.page, path: quote.pdfPath });
  return `\`\`\`pdf-quote\n${meta}\n${quote.text.trim()}\n\`\`\``;
};

const parsePdfQuoteBlock = (value: string): { meta: QuoteMeta; text: string } | null => {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (lines.length < 2) return null;
  try {
    const meta = JSON.parse(lines[0]) as QuoteMeta;
    if (!meta || typeof meta.name !== "string" || typeof meta.page !== "number" || typeof meta.path !== "string") return null;
    return { meta, text: lines.slice(1).join("\n").trim() };
  } catch {
    return null;
  }
};

const isExternalUrl = (value: string) => /^(https?:|data:|asset:|tauri:|blob:)/i.test(value);

const getDirname = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : normalized;
};

const joinPath = (base: string, relative: string) => {
  if (!base) return relative;
  const baseParts = base.replace(/\\/g, "/").split("/");
  const relativeParts = relative.replace(/\\/g, "/").split("/");
  const segments = [...baseParts];

  for (const part of relativeParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(part);
  }

  return segments.join("/");
};

const guessImageMimeType = (path: string) => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "application/octet-stream";
};

function MarkdownImage(props: { src: string; alt?: string; title?: string; assetBase: string }) {
  const { src, alt, title, assetBase } = props;
  const [blobUrl, setBlobUrl] = useState("");
  const [failed, setFailed] = useState(false);

  const resolvedSrc = useMemo(() => {
    if (!src) return "";
    if (isExternalUrl(src) || /^[a-zA-Z]:[\\/]/.test(src) || src.startsWith("/")) return src;
    return joinPath(assetBase, src);
  }, [assetBase, src]);

  useEffect(() => {
    let disposed = false;
    let localUrl = "";

    if (!resolvedSrc || isExternalUrl(resolvedSrc)) {
      setBlobUrl(resolvedSrc);
      setFailed(false);
      return;
    }

    setBlobUrl("");
    setFailed(false);

    void (async () => {
      try {
        const bytes = await invoke<number[]>("read_binary_file", { path: resolvedSrc });
        if (disposed) return;
        const blob = new Blob([new Uint8Array(bytes)], { type: guessImageMimeType(resolvedSrc) });
        localUrl = URL.createObjectURL(blob);
        setBlobUrl(localUrl);
      } catch {
        if (!disposed) setFailed(true);
      }
    })();

    return () => {
      disposed = true;
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [resolvedSrc]);

  return (
    <span className="markdown-image-wrap">
      {blobUrl && !failed ? (
        <img
          src={blobUrl}
          alt={alt ?? ""}
          title={title}
          className="markdown-image"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="markdown-image-error">{alt || src}</span>
      )}
      {alt ? <span className="markdown-image-caption">{alt}</span> : null}
    </span>
  );
}

export function NotesPane() {
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const notes = useAppStore((s) => s.notes);
  const setNotes = useAppStore((s) => s.setNotes);
  const appendToNotes = useAppStore((s) => s.appendToNotes);
  const selectedPdfText = useAppStore((s) => s.selectedPdfText);
  const selectedPdfQuote = useAppStore((s) => s.selectedPdfQuote);
  const setSelectedPdfQuote = useAppStore((s) => s.setSelectedPdfQuote);
  const lastAIReply = useAppStore((s) => s.lastAIReply);
  const requestPdfOpen = useAppStore((s) => s.requestPdfOpen);
  const projectPath = useAppStore((s) => s.projectPath);
  const notesFilePath = useAppStore((s) => s.notesFilePath);
  const language = useAppStore((s) => s.settings.language);

  const markdownAssetBase = useMemo(() => {
    if (notesFilePath) return getDirname(notesFilePath);
    if (projectPath) return getDirname(projectPath);
    return "";
  }, [notesFilePath, projectPath]);

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

  const markdownComponents = useMemo<Components>(
    () => ({
      code(props) {
        const language = props.className?.replace("language-", "") ?? "";
        const value = String(props.children ?? "");
        if (language === "pdf-quote") {
          const parsed = parsePdfQuoteBlock(value);
          if (!parsed) return <pre>{value}</pre>;
          return (
            <blockquote className="pdf-quote-block">
              <button
                type="button"
                className="pdf-quote-header"
                onClick={() => requestPdfOpen(parsed.meta.path, { preserveState: true, targetPage: parsed.meta.page })}
              >
                {parsed.meta.name} / page {parsed.meta.page}
              </button>
              <div className="pdf-quote-content whitespace-pre-wrap">{parsed.text}</div>
            </blockquote>
          );
        }
        if (!value.includes("\n")) {
          return <code className={props.className}>{props.children}</code>;
        }
        return (
          <pre className="markdown-code-block">
            <code className={props.className}>{props.children}</code>
          </pre>
        );
      },
      ul(props) {
        return <ul className="list-disc pl-6" {...props} />;
      },
      ol(props) {
        return <ol className="list-decimal pl-6" {...props} />;
      },
      li(props) {
        return <li className="my-1" {...props} />;
      },
      img(props) {
        const src = typeof props.src === "string" ? props.src.trim() : "";
        if (!src) return null;
        return <MarkdownImage src={src} alt={props.alt} title={props.title} assetBase={markdownAssetBase} />;
      }
    }),
    [markdownAssetBase, requestPdfOpen]
  );

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

  return (
    <section className="app-panel flex h-full flex-col rounded border border-border">
      <header className="app-section-header flex items-center justify-between border-b border-border p-2">
        <div>
          <div className="text-sm font-semibold">{t(language, "markdown")}</div>
        </div>
        <div className="flex gap-2">
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
            <div className="app-card h-full min-h-0 overflow-hidden rounded border border-border">
              <CodeMirror
                key={`editor-${refreshTick}`}
                className="notes-editor"
                value={notes}
                height="100%"
                extensions={[markdown(), editorHighlightExtension, EditorView.lineWrapping]}
                onChange={(value) => setNotes(value)}
                onCreateEditor={(view) => setEditorView(view)}
                basicSetup={{ lineNumbers: true, foldGutter: true }}
              />
            </div>
          </Panel>

          <PanelResizeHandle className="resize-handle-y" />

          <Panel defaultSize={44} minSize={20}>
            <div className="app-card h-full overflow-auto rounded border border-border p-3">
              <div className="mb-2 text-xs font-semibold text-slate-500">{t(language, "preview")}</div>
              <article className="markdown-preview">
                <div key={`preview-${refreshTick}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={markdownComponents}>
                  {notes || t(language, "writeHere")}
                </ReactMarkdown>
                </div>
              </article>
            </div>
          </Panel>
        </PanelGroup>
      </div>
    </section>
  );
}
