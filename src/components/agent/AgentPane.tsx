import { DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { commandService } from "../../services/commandService";
import { debugLogger } from "../../services/debugLogger";
import { llmService } from "../../services/llmService";
import { nativeFileService } from "../../services/nativeFileService";
import { useAppStore } from "../../stores/appStore";
import { ChatMessage } from "../../types";
import { t } from "../../i18n";

type ReplayableAction = {
  kind: "command" | "chat";
  value: string;
};

const TEXT_FILE_EXTENSIONS = [
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".log",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rs",
  ".go",
  ".rb",
  ".php",
  ".html",
  ".css",
  ".scss",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".sh",
  ".bat"
];

let pdfJsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
const getPdfJs = async () => {
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      return pdfjs;
    })();
  }
  return pdfJsPromise;
};

const isTextAttachment = (path: string) => TEXT_FILE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
const isPdfAttachment = (path: string) => path.toLowerCase().endsWith(".pdf");
const hasFiles = (types: readonly string[] | DOMStringList | undefined) => Array.from(types ?? []).includes("Files");

const pairCommandMessages = (messages: ChatMessage[]) => {
  const items: Array<{ kind: "message"; message: ChatMessage } | { kind: "command"; input: ChatMessage; output?: ChatMessage }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    const next = messages[index + 1];
    if (current.role === "user" && current.source === "command") {
      if (next && next.role === "assistant" && next.source === "command") {
        items.push({ kind: "command", input: current, output: next });
        index += 1;
        continue;
      }
      items.push({ kind: "command", input: current });
      continue;
    }
    if (current.role === "assistant" && current.source === "command") continue;
    items.push({ kind: "message", message: current });
  }
  return items;
};

const logDrag = (message: string) => {
  console.info(message);
  debugLogger.info(message);
};

const clampMenuPosition = (x: number, y: number) => {
  const width = 128;
  const height = 52;
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - height - 8))
  };
};

const isErrorLikeMessage = (message: ChatMessage) =>
  message.role === "assistant" &&
  ((message.source ?? "chat") === "error" ||
    /^error\s*:/i.test(message.content.trim()) ||
    /request failed|invalid api key|timeout|network|unauthorized|forbidden/i.test(message.content));

export function AgentPane() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const dialogs = useAppStore((s) => s.dialogs);
  const activeDialogId = useAppStore((s) => s.activeDialogId);
  const attachments = useAppStore((s) => s.attachments);
  const addMessage = useAppStore((s) => s.addMessage);
  const updateMessage = useAppStore((s) => s.updateMessage);
  const addAttachment = useAppStore((s) => s.addAttachment);
  const removeAttachment = useAppStore((s) => s.removeAttachment);
  const setAttachments = useAppStore((s) => s.setAttachments);
  const setLastAIReply = useAppStore((s) => s.setLastAIReply);
  const showThinking = useAppStore((s) => s.settings.showThinking);
  const enableAgentAttachments = useAppStore((s) => s.settings.enableAgentAttachments);
  const includeProjectContextInChat = useAppStore((s) => s.settings.includeProjectContextInChat);
  const hideCommandMessages = useAppStore((s) => s.settings.hideCommandMessages);
  const setSettings = useAppStore((s) => s.setSettings);
  const setActiveDialog = useAppStore((s) => s.setActiveDialog);
  const createDialog = useAppStore((s) => s.createDialog);
  const deleteDialog = useAppStore((s) => s.deleteDialog);
  const pdfPath = useAppStore((s) => s.pdfPath);
  const pdfName = useAppStore((s) => s.pdfName);
  const currentPage = useAppStore((s) => s.currentPage);
  const currentPageText = useAppStore((s) => s.currentPageText);
  const pageTextCache = useAppStore((s) => s.pageTextCache);
  const language = useAppStore((s) => s.settings.language);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const attachmentZoneRef = useRef<HTMLDivElement | null>(null);
  const lastReplayableActionRef = useRef<ReplayableAction | null>(null);

  const activeDialog = dialogs.find((dialog) => dialog.id === activeDialogId) ?? dialogs[0];
  const sorted = useMemo(() => [...(activeDialog?.messages ?? [])].sort((a, b) => a.createdAt - b.createdAt), [activeDialog]);
  const pairedMessages = useMemo(() => pairCommandMessages(sorted), [sorted]);
  const visibleItems = useMemo(
    () => (hideCommandMessages ? pairedMessages.filter((item) => item.kind !== "command") : pairedMessages),
    [hideCommandMessages, pairedMessages]
  );
  const latestMessage = sorted[sorted.length - 1];

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    const container = messageListRef.current;
    if (!container) return;
    requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior });
    });
  };

  const isWithinAttachmentZone = (x: number, y: number) => {
    const rect = attachmentZoneRef.current?.getBoundingClientRect();
    if (!rect) return false;
    const scale = window.devicePixelRatio || 1;
    const left = rect.left * scale;
    const top = rect.top * scale;
    const right = rect.right * scale;
    const bottom = rect.bottom * scale;
    return x >= left && x <= right && y >= top && y <= bottom;
  };

  useEffect(() => {
    scrollToBottom(loading ? "auto" : "smooth");
  }, [activeDialogId, latestMessage?.id, latestMessage?.content, latestMessage?.reasoning, loading, visibleItems.length]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("blur", closeMenu);
    };
  }, []);

  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: string }>).detail;
      if (!detail?.target || detail.target === "agent" || detail.target === "cache") {
        scrollToBottom("auto");
        setContextMenu(null);
      }
    };
    window.addEventListener("agent:refresh", onRefresh as EventListener);
    return () => window.removeEventListener("agent:refresh", onRefresh as EventListener);
  }, []);

  const readPdfAttachment = async (path: string, fallbackName?: string) => {
    const pdfjs = await getPdfJs();
    const bytes = new Uint8Array(await invoke<number[]>("read_binary_file", { path }));
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const pages: string[] = [];
    const maxPages = Math.min(doc.numPages, 12);

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) pages.push(`Page ${pageNumber}\n${text}`);
    }

    addAttachment({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: fallbackName ?? path.split(/[\\/]/).pop() ?? path,
      content: pages.join("\n\n").slice(0, 48000),
      sourcePath: path
    });
  };

  const addAttachmentFromPath = async (path: string) => {
    if (isPdfAttachment(path)) {
      await readPdfAttachment(path);
      return;
    }
    if (!isTextAttachment(path)) return;
    const content = await nativeFileService.readTextFile(path);
    addAttachment({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: path.split(/[\\/]/).pop() ?? path,
      content,
      sourcePath: path
    });
  };

  const addCurrentPdfPageAttachment = async (page = currentPage) => {
    const textValue = pageTextCache[page] ?? (page === currentPage ? currentPageText : "");
    if (!pdfPath || !textValue.trim()) return;
    addAttachment({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: `${pdfName || pdfPath.split(/[\\/]/).pop() || "PDF"}#page-${page}`,
      content: textValue.trim(),
      page,
      sourcePath: pdfPath
    });
  };

  const addAttachmentFromDroppedFile = async (file: File & { path?: string }) => {
    if (file.path) {
      await addAttachmentFromPath(file.path);
      return;
    }
    if (file.name.toLowerCase().endsWith(".pdf")) {
      const pdfjs = await getPdfJs();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = await pdfjs.getDocument({ data: bytes }).promise;
      const pages: string[] = [];
      const maxPages = Math.min(doc.numPages, 12);

      for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
        const page = await doc.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const text = textContent.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text) pages.push(`Page ${pageNumber}\n${text}`);
      }

      addAttachment({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        content: pages.join("\n\n").slice(0, 48000)
      });
      return;
    }
    if (!isTextAttachment(file.name)) return;
    const content = await file.text();
    addAttachment({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      content
    });
  };

  const acceptNativePaths = async (paths: string[]) => {
    logDrag(`[AGENT] native drop accepted count=${paths.length} paths=${paths.join(",")}`);
    for (const path of paths) {
      await addAttachmentFromPath(path);
    }
  };

  const extractDroppedFiles = (dataTransfer: DataTransfer) => {
    const itemFiles = Array.from(dataTransfer.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    const fallbackFiles = Array.from(dataTransfer.files) as Array<File & { path?: string }>;
    logDrag(
      `[AGENT] html drop inspect items=${dataTransfer.items?.length ?? 0} files=${dataTransfer.files?.length ?? 0} names=${[...itemFiles, ...fallbackFiles]
        .map((file) => file.name)
        .join(",")}`
    );
    return itemFiles.length > 0 ? (itemFiles as Array<File & { path?: string }>) : fallbackFiles;
  };

  const acceptDroppedFiles = async (dataTransfer: DataTransfer) => {
    const files = extractDroppedFiles(dataTransfer);
    logDrag(`[AGENT] html drop accepted count=${files.length}`);
    for (const file of files) {
      await addAttachmentFromDroppedFile(file);
    }
  };

  useEffect(() => {
    if (!enableAgentAttachments) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent(async ({ payload }) => {
        if (disposed) return;
        if (payload.type === "enter") {
          logDrag(`[AGENT] native dragenter paths=${payload.paths.join(",")}`);
          setDragging(isWithinAttachmentZone(payload.position.x, payload.position.y));
          return;
        }
        if (payload.type === "over") {
          setDragging(isWithinAttachmentZone(payload.position.x, payload.position.y));
          return;
        }
        if (payload.type === "leave") {
          logDrag("[AGENT] native dragleave");
          setDragging(false);
          return;
        }
        if (payload.type === "drop") {
          logDrag(`[AGENT] native drop paths=${payload.paths.join(",")}`);
          if (!isWithinAttachmentZone(payload.position.x, payload.position.y)) {
            setDragging(false);
            return;
          }
          setDragging(false);
          await acceptNativePaths(payload.paths);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => {
        logDrag(`[AGENT] native drag init failed ${error instanceof Error ? error.message : String(error)}`);
      });

    return () => {
      disposed = true;
      setDragging(false);
      if (unlisten) unlisten();
    };
  }, [enableAgentAttachments]);

  const attachFile = async () => {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "Compatible files",
          extensions: ["txt", "md", "json", "csv", "log", "pdf", "ts", "tsx", "js", "jsx", "py", "java", "c", "cpp", "h", "hpp", "rs", "go", "rb", "php", "html", "css", "scss", "xml", "yaml", "yml", "toml", "ini", "sh", "bat"]
        },
        { name: "All", extensions: ["*"] }
      ]
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const path of paths) {
      await addAttachmentFromPath(path);
    }
  };

  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    if (!hasFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    await acceptDroppedFiles(event.dataTransfer);
  };

  const runChatCompletion = async (dialogId: string, history: ChatMessage[], assistantMessageId?: string) => {
    let targetAssistantId = assistantMessageId;
    if (!targetAssistantId) {
      const assistantMessage = commandService.createMessage("assistant", "", "chat");
      targetAssistantId = assistantMessage.id;
      addMessage(assistantMessage, dialogId);
    } else {
      updateMessage(targetAssistantId, { content: "", reasoning: "", source: "chat" });
    }

    let streamedReply = "";
    let streamedReasoning = "";
    try {
      const reply = await llmService.sendChatStream(history, {
        onToken: (token) => {
          streamedReply += token;
          updateMessage(targetAssistantId, { content: streamedReply, source: "chat" });
        },
        onReasoning: (token) => {
          streamedReasoning += token;
          updateMessage(targetAssistantId, { reasoning: streamedReasoning, source: "chat" });
        }
      });

      updateMessage(targetAssistantId, { content: reply, reasoning: streamedReasoning, source: "chat" });
      setLastAIReply(reply);
      return reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
      updateMessage(targetAssistantId, { content: `Error: ${message}`, reasoning: "", source: "error" });
      setLastAIReply("");
      throw error;
    }
  };

  const executeSubmission = async (submittedValue: string, options?: { remember?: boolean }) => {
    if (!activeDialog) return;
    const value = submittedValue.trim();
    if (!value) return;

    const remember = options?.remember ?? true;
    setLoading(true);
    try {
      if (value.startsWith(">>")) {
        if (value.toLowerCase() === ">>prev") {
          addMessage(commandService.createMessage("user", value, "command"), activeDialog.id);
          const previous = lastReplayableActionRef.current;
          if (!previous) {
            addMessage(
              commandService.createMessage(
                "assistant",
                language === "en" ? "Basic command: no previous action to repeat" : "基础指令：没有可重复的上一条操作",
                "command"
              ),
              activeDialog.id
            );
            return;
          }

          addMessage(
            commandService.createMessage(
              "assistant",
              language === "en"
                ? `Basic command: repeated previous ${previous.kind === "chat" ? "chat" : "command"}`
                : `基础指令：已重复上一条${previous.kind === "chat" ? "对话" : "指令"}`,
              "command"
            ),
            activeDialog.id
          );
          await executeSubmission(previous.value, { remember: false });
          return;
        }

        addMessage(commandService.createMessage("user", value, "command"), activeDialog.id);
        const result = await commandService.execute(value);
        addMessage(commandService.createMessage("assistant", result, "command"), activeDialog.id);
        if (remember) {
          lastReplayableActionRef.current = { kind: "command", value };
        }
        return;
      }

      const userMessage = commandService.createMessage("user", value, "chat");
      addMessage(userMessage, activeDialog.id);
      await runChatCompletion(activeDialog.id, [...activeDialog.messages, userMessage]);
      if (remember) {
        lastReplayableActionRef.current = { kind: "chat", value };
      }
    } catch (error) {
      if (value.startsWith(">>")) {
        const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
        addMessage(commandService.createMessage("assistant", `Error: ${message}`, "error"), activeDialog.id);
      }
    } finally {
      setLoading(false);
      scrollToBottom("auto");
    }
  };

  const regenerateMessage = async (messageId: string) => {
    if (!activeDialog) return;
    const messageIndex = sorted.findIndex((item) => item.id === messageId);
    if (messageIndex <= 0) return;
    const history = sorted.slice(0, messageIndex).filter((item) => (item.source ?? "chat") === "chat");
    const lastUser = [...history].reverse().find((item) => item.role === "user");
    if (!lastUser) return;

    setLoading(true);
    try {
      await runChatCompletion(activeDialog.id, history, messageId);
      lastReplayableActionRef.current = { kind: "chat", value: lastUser.content };
    } catch {
      // Error state is already written back into the message bubble.
    } finally {
      setLoading(false);
      scrollToBottom("auto");
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    setInput("");
    await executeSubmission(value);
  };

  const menu = contextMenu
    ? createPortal(
        <div
          className="fixed z-[120] min-w-[120px] rounded-xl border border-border bg-panel p-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="w-full rounded-lg px-3 py-2 text-left text-xs"
            onClick={() => {
              const currentId = contextMenu.id;
              if (dialogs.length <= 1) {
                createDialog();
              }
              deleteDialog(currentId);
              setContextMenu(null);
            }}
          >
            {t(language, "deleteDialog")}
          </button>
        </div>,
        document.body
      )
    : null;

  return (
    <section className="app-panel relative flex h-full flex-col rounded border border-border">
      <header className="app-section-header flex items-center justify-between gap-2 border-b border-border p-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{t(language, "agent")}</div>
        </div>
        <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => createDialog()}>
          {t(language, "newDialog")}
        </button>
      </header>

      <div className="flex gap-2 overflow-x-auto border-b border-border px-2 py-2">
        {dialogs.map((dialog) => (
          <button
            key={dialog.id}
            type="button"
            className={`min-w-[120px] rounded-xl border px-3 py-1 text-left text-xs ${dialog.id === activeDialogId ? "theme-active" : ""}`}
            onClick={() => setActiveDialog(dialog.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              const next = clampMenuPosition(event.clientX, event.clientY);
              setContextMenu({ id: dialog.id, x: next.x, y: next.y });
            }}
          >
            <div className="truncate font-medium">{dialog.title}</div>
            <div className="truncate text-slate-500">
              {dialog.messages.length} {t(language, "msgs")}
            </div>
          </button>
        ))}
      </div>

      <div ref={messageListRef} className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
        {visibleItems.length === 0 && (
          <div className="text-sm text-slate-500">
            {t(language, "startDialog")} <code>&gt;&gt;help</code>.
          </div>
        )}
        {visibleItems.map((item, index) =>
          item.kind === "command" ? (
            <div key={`${item.input.id}-${index}`} className="rounded-xl border border-border bg-white/40 p-3 text-sm dark:bg-slate-900/40">
              <div className="mb-2 text-xs font-semibold text-slate-500">{t(language, "command")}</div>
              <div className="rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs dark:bg-slate-950/70">{item.input.content}</div>
              <div className="mt-2 whitespace-pre-wrap rounded-lg border border-border px-3 py-2">{item.output?.content ?? t(language, "running")}</div>
            </div>
          ) : (
            <div key={item.message.id} className={`rounded border px-2 py-2 text-sm ${item.message.role === "user" ? "agent-user-message" : "agent-ai-message"}`}>
              <div className="mb-1 text-xs text-slate-500">{item.message.role === "user" ? t(language, "user") : t(language, "assistant")}</div>
              {showThinking && item.message.reasoning && (
                <details className="thinking-panel mb-2 rounded border border-border px-2 py-1">
                  <summary className="cursor-pointer text-xs text-slate-500">{t(language, "thinking")}</summary>
                  <div className="mt-2 whitespace-pre-wrap text-xs">{item.message.reasoning}</div>
                </details>
              )}
              <article className="markdown-preview text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {item.message.content}
                </ReactMarkdown>
              </article>
              {isErrorLikeMessage(item.message) && (
                <div className="mt-2">
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-1 text-xs"
                    disabled={loading}
                    onClick={() => void regenerateMessage(item.message.id)}
                  >
                    {language === "en" ? "Regenerate" : "重新生成"}
                  </button>
                </div>
              )}
            </div>
          )
        )}
      </div>

      <form onSubmit={onSubmit} className="app-section-header border-t border-border p-2">
        {enableAgentAttachments && (
          <div
            ref={attachmentZoneRef}
            className={`mb-2 rounded-xl border border-dashed p-2 transition ${dragging ? "theme-active" : ""}`}
            onDragEnter={(event) => {
              if (!hasFiles(event.dataTransfer.types)) return;
              event.preventDefault();
              event.stopPropagation();
              setDragging(true);
              logDrag("[AGENT] html dragenter zone");
            }}
            onDragOver={(event) => {
              if (!hasFiles(event.dataTransfer.types)) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "copy";
              if (!dragging) setDragging(true);
            }}
            onDragLeave={(event) => {
              if (!hasFiles(event.dataTransfer.types)) return;
              event.preventDefault();
              event.stopPropagation();
              setDragging(false);
            }}
            onDrop={(event) => void handleDrop(event)}
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => void attachFile()}>
                {t(language, "addAttachment")}
              </button>
              <button type="button" className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50" disabled={!pdfPath} onClick={() => void addCurrentPdfPageAttachment()}>
                {language === "en" ? "Attach page" : "添加当前页"}
              </button>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs"
                onClick={() => {
                  setAttachments([]);
                  logDrag("[AGENT] attachments cleared");
                }}
              >
                {language === "en" ? "Clear attachments" : "清除附件"}
              </button>
              <label className="inline-flex items-center gap-2 text-xs">
                <input type="checkbox" checked={includeProjectContextInChat} onChange={(event) => setSettings({ includeProjectContextInChat: event.target.checked })} />
                {t(language, "includeProjectContext")}
              </label>
              <label className="inline-flex items-center gap-2 text-xs">
                <input type="checkbox" checked={hideCommandMessages} onChange={(event) => setSettings({ hideCommandMessages: event.target.checked })} />
                {language === "en" ? "Hide commands" : "隐藏指令"}
              </label>
            </div>
            <div className="text-xs text-slate-500">{dragging ? t(language, "dropFilesActive") : t(language, "dropFiles")}</div>
            {attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {attachments.map((item) => (
                  <span key={item.id} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs">
                    {item.name}
                    <button type="button" className="border-0 bg-transparent p-0 text-slate-500" onClick={() => removeAttachment(item.id)}>
                      x
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <textarea
          className="mb-2 min-h-[88px] w-full resize-y rounded border border-border px-2 py-2 text-sm"
          placeholder={t(language, "askAgent")}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              const value = input.trim();
              if (!value) return;
              setInput("");
              void executeSubmission(value);
            }
          }}
          disabled={loading}
        />
        <button type="submit" className="accent-button w-full rounded border border-border px-2 py-1 text-sm disabled:opacity-50" disabled={loading}>
          {loading ? `${t(language, "thinking")}...` : t(language, "send")}
        </button>
      </form>

      {menu}
    </section>
  );
}
