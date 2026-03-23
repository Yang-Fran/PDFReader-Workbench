import { ClipboardEvent, DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { commandService } from "../../services/commandService";
import { useBackdropClose } from "../../hooks/useBackdropClose";
import { extractSelectionMarkdown, isSelectionInside } from "../../utils/selectionMarkdown";
import { formatUiError, repairMojibake } from "../../utils/textDisplay";
import { debugLogger } from "../../services/debugLogger";
import { llmService } from "../../services/llmService";
import { ocrService } from "../../services/ocrService";
import { nativeFileService } from "../../services/nativeFileService";
import { RichMarkdown } from "../markdown/RichMarkdown";
import { useAppStore } from "../../stores/appStore";
import { AgentDialog, ChatMessage } from "../../types";
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
const IMAGE_FILE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
const ATTACHMENT_PICKER_EXTENSIONS = [...new Set(["pdf", ...TEXT_FILE_EXTENSIONS.map((extension) => extension.slice(1)), ...IMAGE_FILE_EXTENSIONS.map((extension) => extension.slice(1))])];

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

const createAttachmentId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const getAttachmentName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const isTextAttachment = (path: string) => TEXT_FILE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
const isPdfAttachment = (path: string) => path.toLowerCase().endsWith(".pdf");
const isImageAttachment = (path: string) => IMAGE_FILE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
const hasFiles = (types: readonly string[] | DOMStringList | undefined) => Array.from(types ?? []).includes("Files");
const isImageFile = (file: Pick<File, "name" | "type">) => file.type.startsWith("image/") || isImageAttachment(file.name);

const getImageExtensionFromMimeType = (mimeType: string) => {
  const lower = mimeType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("gif")) return ".gif";
  if (lower.includes("bmp")) return ".bmp";
  return ".png";
};

const guessImageMimeType = (path: string) => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "image/png";
};

const buildFallbackImageName = (name: string, mimeType: string) => name || `clipboard-${Date.now()}${getImageExtensionFromMimeType(mimeType)}`;

const extractClipboardFiles = (dataTransfer: DataTransfer | null) => {
  if (!dataTransfer) return [] as Array<File & { path?: string }>;
  const itemFiles = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null) as Array<File & { path?: string }>;
  const fallbackFiles = Array.from(dataTransfer.files) as Array<File & { path?: string }>;
  return itemFiles.length > 0 ? itemFiles : fallbackFiles;
};

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
  const width = 148;
  const height = 104;
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - height - 8))
  };
};

const isChatMessage = (message: ChatMessage) => (message.source ?? "chat") === "chat" || (message.source ?? "chat") === "error";

const findAssistantReplyIndex = (messages: ChatMessage[], userIndex: number) => {
  const next = messages[userIndex + 1];
  if (!next) return -1;
  return next.role === "assistant" && isChatMessage(next) ? userIndex + 1 : -1;
};

const canRegenerateMessage = (messages: ChatMessage[], messageId: string) => {
  const index = messages.findIndex((item) => item.id === messageId);
  if (index <= 0) return false;
  const message = messages[index];
  if (message.role !== "assistant" || !isChatMessage(message)) return false;
  const previous = messages[index - 1];
  return previous?.role === "user" && (previous.source ?? "chat") === "chat";
};

const buildDialogSearchText = (dialog: AgentDialog) =>
  [dialog.title, ...dialog.messages.filter((message) => (message.source ?? "chat") === "chat").slice(-6).map((message) => message.content)]
    .join("\n")
    .toLowerCase();

const buildDialogSnippet = (dialog: AgentDialog) => {
  const latestUser = [...dialog.messages].reverse().find((message) => message.role === "user" && (message.source ?? "chat") === "chat");
  const latestMessage = [...dialog.messages].reverse().find((message) => (message.source ?? "chat") !== "command");
  return (latestUser?.content || latestMessage?.content || "").replace(/\s+/g, " ").trim();
};

const formatDialogTimestamp = (value: number, language: "zh" | "en") =>
  new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));

const loadImageElement = async (blob: Blob) => {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to load image attachment."));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
};

export function AgentPane() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renameDialogState, setRenameDialogState] = useState<{ id: string; value: string } | null>(null);
  const [editMessageState, setEditMessageState] = useState<{ id: string; value: string } | null>(null);
  const [dialogQuery, setDialogQuery] = useState("");
  const dialogs = useAppStore((s) => s.dialogs);
  const activeDialogId = useAppStore((s) => s.activeDialogId);
  const attachments = useAppStore((s) => s.attachments);
  const addMessage = useAppStore((s) => s.addMessage);
  const updateMessage = useAppStore((s) => s.updateMessage);
  const replaceDialogMessages = useAppStore((s) => s.replaceDialogMessages);
  const addAttachment = useAppStore((s) => s.addAttachment);
  const removeAttachment = useAppStore((s) => s.removeAttachment);
  const setAttachments = useAppStore((s) => s.setAttachments);
  const setLastAIReply = useAppStore((s) => s.setLastAIReply);
  const showThinking = useAppStore((s) => s.settings.showThinking);
  const enableAgentAttachments = useAppStore((s) => s.settings.enableAgentAttachments);
  const includeProjectContextInChat = useAppStore((s) => s.settings.includeProjectContextInChat);
  const hideCommandMessages = useAppStore((s) => s.settings.hideCommandMessages);
  const translationTask = useAppStore((s) => s.translationTask);
  const setSettings = useAppStore((s) => s.setSettings);
  const setActiveDialog = useAppStore((s) => s.setActiveDialog);
  const createDialog = useAppStore((s) => s.createDialog);
  const deleteDialog = useAppStore((s) => s.deleteDialog);
  const renameDialog = useAppStore((s) => s.renameDialog);
  const pdfPath = useAppStore((s) => s.pdfPath);
  const pdfName = useAppStore((s) => s.pdfName);
  const currentPage = useAppStore((s) => s.currentPage);
  const currentPageText = useAppStore((s) => s.currentPageText);
  const pageTextCache = useAppStore((s) => s.pageTextCache);
  const setPageTextCache = useAppStore((s) => s.setPageTextCache);
  const language = useAppStore((s) => s.settings.language);
  const setSelectedPdfText = useAppStore((s) => s.setSelectedPdfText);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const attachmentZoneRef = useRef<HTMLDivElement | null>(null);
  const lastReplayableActionRef = useRef<ReplayableAction | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const previousLatestMessageIdRef = useRef("");
  const previousVisibleCountRef = useRef(0);

  const activeDialog = dialogs.find((dialog) => dialog.id === activeDialogId) ?? dialogs[0];
  const sorted = useMemo(() => [...(activeDialog?.messages ?? [])].sort((a, b) => a.createdAt - b.createdAt), [activeDialog]);
  const pairedMessages = useMemo(() => pairCommandMessages(sorted), [sorted]);
  const filteredDialogs = useMemo(() => {
    const query = dialogQuery.trim().toLowerCase();
    const ordered = [...dialogs].sort((left, right) => right.updatedAt - left.updatedAt);
    if (!query) return ordered;
    return ordered.filter((dialog) => buildDialogSearchText(dialog).includes(query));
  }, [dialogQuery, dialogs]);
  const visibleItems = useMemo(
    () => (hideCommandMessages ? pairedMessages.filter((item) => item.kind !== "command") : pairedMessages),
    [hideCommandMessages, pairedMessages]
  );
  const latestMessage = sorted[sorted.length - 1];
  const isNearBottom = (container: HTMLDivElement) => container.scrollHeight - container.scrollTop - container.clientHeight < 56;

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
    const container = messageListRef.current;
    if (!container) return;

    const handleScroll = () => {
      shouldAutoScrollRef.current = isNearBottom(container);
    };

    shouldAutoScrollRef.current = isNearBottom(container);
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [activeDialogId]);

  useEffect(() => {
    const currentLatestId = latestMessage?.id ?? "";
    const messageChanged = currentLatestId !== previousLatestMessageIdRef.current || visibleItems.length !== previousVisibleCountRef.current;

    if (messageChanged) {
      scrollToBottom(loading ? "auto" : "smooth");
      shouldAutoScrollRef.current = true;
    } else if (loading && currentLatestId && shouldAutoScrollRef.current) {
      scrollToBottom("auto");
    }

    previousLatestMessageIdRef.current = currentLatestId;
    previousVisibleCountRef.current = visibleItems.length;
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

  useEffect(() => {
    const container = messageListRef.current;
    if (!container) return;

    const handleMouseUp = () => {
      const selection = window.getSelection();
      if (!isSelectionInside(selection, container)) return;
      const markdown = extractSelectionMarkdown(selection, container);
      if (markdown) setSelectedPdfText(markdown);
    };

    container.addEventListener("mouseup", handleMouseUp);
    return () => container.removeEventListener("mouseup", handleMouseUp);
  }, [setSelectedPdfText, visibleItems.length]);

  const extractPdfPageText = async (page: number) => {
    const cached = pageTextCache[page] ?? (page === currentPage ? currentPageText : "");
    if (cached.trim()) return cached.trim();
    if (!pdfPath) return "";
    const pdfjs = await getPdfJs();
    const bytes = new Uint8Array(await invoke<number[]>("read_binary_file", { path: pdfPath }));
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    if (page < 1 || page > doc.numPages) return "";
    const pdfPage = await doc.getPage(page);
    const textContent = await pdfPage.getTextContent();
    const text = textContent.items.map((item) => ("str" in item ? item.str : "")).join(" ").replace(/\s+/g, " ").trim();
    if (text) setPageTextCache(page, text);
    return text;
  };

  const addCurrentPdfPageAttachment = async (page = currentPage) => {
    const textValue = await extractPdfPageText(page);
    if (!pdfPath || !textValue.trim()) return false;
    addAttachment({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: `${pdfName || pdfPath.split(/[\\/]/).pop() || "PDF"}#page-${page}`,
      content: textValue.trim(),
      page,
      sourcePath: pdfPath
    });
    return true;
  };

  const addPdfPageAttachments = async (pages: number[]) => {
    const attached: number[] = [];
    for (const page of pages) {
      if (await addCurrentPdfPageAttachment(page)) attached.push(page);
    }
    return attached;
  };

  const appendAttachment = (name: string, content: string, options?: { page?: number; sourcePath?: string }) => {
    addAttachment({
      id: createAttachmentId(),
      name,
      content,
      page: options?.page,
      sourcePath: options?.sourcePath
    });
  };

  const addImageAttachmentFromBlob = async (blob: Blob, options?: { name?: string; sourcePath?: string }) => {
    setAttachmentBusy(true);
    try {
      const image = await loadImageElement(blob);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Failed to create OCR canvas.");
      ctx.drawImage(image, 0, 0);
      const result = await ocrService.recognizeCanvas(canvas);
      appendAttachment(options?.name ?? buildFallbackImageName("", blob.type), result.text.trim() || "[No readable text detected in image.]", {
        sourcePath: options?.sourcePath
      });
    } finally {
      setAttachmentBusy(false);
    }
  };

  const addImageAttachmentFromPath = async (path: string) => {
    const bytes = new Uint8Array(await invoke<number[]>("read_binary_file", { path }));
    const blob = new Blob([bytes], { type: guessImageMimeType(path) });
    await addImageAttachmentFromBlob(blob, { name: getAttachmentName(path), sourcePath: path });
  };

  const addPdfAttachmentFromBytes = async (bytes: Uint8Array, name: string, sourcePath?: string) => {
    const pdfjs = await getPdfJs();
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

    appendAttachment(name, pages.join("\n\n").slice(0, 48000), { sourcePath });
  };

  const addAttachmentFromPath = async (path: string) => {
    if (isPdfAttachment(path)) {
      const bytes = new Uint8Array(await invoke<number[]>("read_binary_file", { path }));
      await addPdfAttachmentFromBytes(bytes, getAttachmentName(path), path);
      return;
    }
    if (isImageAttachment(path)) {
      await addImageAttachmentFromPath(path);
      return;
    }
    if (!isTextAttachment(path)) return;
    const content = await nativeFileService.readTextFile(path);
    appendAttachment(getAttachmentName(path), content, { sourcePath: path });
  };

  const addAttachmentFromFile = async (file: File & { path?: string }) => {
    if (file.path) {
      await addAttachmentFromPath(file.path);
      return;
    }
    if (isPdfAttachment(file.name)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await addPdfAttachmentFromBytes(bytes, file.name);
      return;
    }
    if (isImageFile(file)) {
      await addImageAttachmentFromBlob(file, { name: buildFallbackImageName(file.name, file.type) });
      return;
    }
    if (!isTextAttachment(file.name)) return;
    const content = await file.text();
    appendAttachment(file.name, content);
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
      await addAttachmentFromFile(file);
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
          extensions: ATTACHMENT_PICKER_EXTENSIONS
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

  const handlePaste = async (event: ClipboardEvent<HTMLElement>) => {
    if (!enableAgentAttachments) return;
    const files = extractClipboardFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    for (const file of files) {
      await addAttachmentFromFile(file);
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
    let pendingFrame = 0;
    const flushStream = () => {
      pendingFrame = 0;
      updateMessage(targetAssistantId, { content: streamedReply, reasoning: streamedReasoning, source: "chat" });
    };
    const scheduleFlush = () => {
      if (pendingFrame) return;
      pendingFrame = requestAnimationFrame(flushStream);
    };
    try {
      const reply = await llmService.sendChatBySettings(history, {
        onToken: (token) => {
          streamedReply += token;
          scheduleFlush();
        },
        onReasoning: (token) => {
          streamedReasoning += token;
          scheduleFlush();
        }
      });

      if (pendingFrame) {
        cancelAnimationFrame(pendingFrame);
        flushStream();
      }
      updateMessage(targetAssistantId, { content: reply, reasoning: streamedReasoning, source: "chat" });
      setLastAIReply(reply);
      return reply;
    } catch (error) {
      if (pendingFrame) cancelAnimationFrame(pendingFrame);
      updateMessage(targetAssistantId, { content: formatUiError(error, language), reasoning: "", source: "error" });
      setLastAIReply("");
      throw error;
    }
  };

  const deleteUserTurn = (messageId: string) => {
    if (!activeDialog) return;
    const userIndex = sorted.findIndex((item) => item.id === messageId);
    if (userIndex < 0) return;
    const assistantIndex = findAssistantReplyIndex(sorted, userIndex);
    const nextMessages = sorted.filter(
      (_, index) => index !== userIndex && index !== assistantIndex
    );
    replaceDialogMessages(activeDialog.id, nextMessages);
  };

  const openEditMessage = (message: ChatMessage) => {
    setEditMessageState({ id: message.id, value: message.content });
  };

  const submitEditMessage = async () => {
    if (!activeDialog || !editMessageState?.value.trim()) return;
    const userIndex = sorted.findIndex((item) => item.id === editMessageState.id);
    if (userIndex < 0) return;

    const originalUser = sorted[userIndex];
    const prefix = sorted.slice(0, userIndex);
    const assistantIndex = findAssistantReplyIndex(sorted, userIndex);
    const assistantPlaceholder =
      assistantIndex >= 0
        ? { ...sorted[assistantIndex], content: "", reasoning: "", source: "chat" as const }
        : commandService.createMessage("assistant", "", "chat");
    const editedUser = { ...originalUser, content: editMessageState.value.trim(), source: "chat" as const };

    replaceDialogMessages(activeDialog.id, [...prefix, editedUser, assistantPlaceholder]);
    setEditMessageState(null);
    setLoading(true);
    try {
      await runChatCompletion(activeDialog.id, [...prefix, editedUser], assistantPlaceholder.id);
      lastReplayableActionRef.current = { kind: "chat", value: editedUser.content };
    } catch {
      // Error state is already written back into the assistant bubble.
    } finally {
      setLoading(false);
      scrollToBottom("auto");
    }
  };

  const executeSubmission = async (submittedValue: string, options?: { remember?: boolean }) => {
    if (!activeDialog) return;
    const value = submittedValue.trim();
    if (!value) return;

    const remember = options?.remember ?? true;
    let runningCommandMessageId = "";
    setLoading(true);
    try {
      if (value.startsWith(">>")) {
        if (value.toLowerCase().startsWith(">>attach")) {
          addMessage(commandService.createMessage("user", value, "command"), activeDialog.id);
          const attachArg = value.replace(/^>>attach/i, "").trim();
          if (attachArg.toLowerCase() === "help") {
            addMessage(commandService.createMessage("assistant", commandService.getHelpText("attach"), "command"), activeDialog.id);
            return;
          }
          const pages = commandService.parsePageExpression(attachArg ? [attachArg] : [], useAppStore.getState().totalPages, useAppStore.getState().currentPage);
          if (pages.length === 0) {
            addMessage(commandService.createMessage("assistant", language === "en" ? "Basic command: no valid pages to attach" : "基础指令：没有可附加的有效页码", "command"), activeDialog.id);
            return;
          }
          setAttachmentBusy(true);
          try {
            const attached = await addPdfPageAttachments(pages);
            addMessage(commandService.createMessage("assistant", attached.length > 0 ? (language === "en" ? `Basic command: attached pages ${attached.join(", ")}` : `基础指令：已附加页面 ${attached.join(", ")}`) : (language === "en" ? "Basic command: no page text available to attach" : "基础指令：没有可附加的页面文本"), "command"), activeDialog.id);
            if (remember) lastReplayableActionRef.current = { kind: "command", value };
          } finally {
            setAttachmentBusy(false);
          }
          return;
        }

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
        const runningMessage = commandService.createMessage("assistant", t(language, "running"), "command");
        runningCommandMessageId = runningMessage.id;
        addMessage(runningMessage, activeDialog.id);
        const result = await commandService.execute(value);
          updateMessage(runningMessage.id, { content: result, source: "command" });
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
        if (runningCommandMessageId) {
          updateMessage(runningCommandMessageId, { content: formatUiError(error, language), source: "command" });
        } else {
          addMessage(commandService.createMessage("assistant", formatUiError(error, language), "command"), activeDialog.id);
        }
        if (remember) {
          lastReplayableActionRef.current = { kind: "command", value };
        }
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
    const history = sorted.slice(0, messageIndex);
    const lastUser = [...history].reverse().find((item) => item.role === "user" && (item.source ?? "chat") === "chat");
    if (!lastUser) return;

    replaceDialogMessages(activeDialog.id, [
      ...history,
      { ...sorted[messageIndex], content: "", reasoning: "", source: "chat" }
    ]);
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

  const openRenameDialog = (id: string) => {
    const dialog = dialogs.find((item) => item.id === id);
    setRenameDialogState({ id, value: dialog?.title ?? "" });
    setContextMenu(null);
  };

  const submitRenameDialog = () => {
    if (!renameDialogState?.value.trim()) return;
    renameDialog(renameDialogState.id, renameDialogState.value.trim());
    setRenameDialogState(null);
  };

  const renameBackdropProps = useBackdropClose<HTMLDivElement>(() => setRenameDialogState(null));
  const editBackdropProps = useBackdropClose<HTMLDivElement>(() => setEditMessageState(null));

  const renameModal = renameDialogState
    ? createPortal(
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4" {...renameBackdropProps}>
          <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-3 text-sm font-semibold">{language === "en" ? "Rename dialog" : "重命名对话"}</div>
            <input
              autoFocus
              className="mb-3 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm text-slate-900 dark:bg-slate-950 dark:text-slate-100"
              value={renameDialogState.value}
              onChange={(event) => setRenameDialogState((state) => (state ? { ...state, value: event.target.value } : state))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitRenameDialog();
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-xl border border-border px-3 py-1.5 text-xs" onClick={() => setRenameDialogState(null)}>
                {language === "en" ? "Cancel" : "取消"}
              </button>
              <button type="button" className="accent-button rounded-xl border px-3 py-1.5 text-xs" onClick={submitRenameDialog}>
                {language === "en" ? "Save" : "保存"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  const editModal = editMessageState
    ? createPortal(
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4" {...editBackdropProps}>
          <div className="w-full max-w-2xl rounded-2xl border border-border bg-panel p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-3 text-sm font-semibold">{language === "en" ? "Edit message" : "编辑消息"}</div>
            <textarea
              autoFocus
              className="mb-3 min-h-[220px] w-full rounded-xl border border-border bg-white px-3 py-2 text-sm text-slate-900 dark:bg-slate-950 dark:text-slate-100"
              value={editMessageState.value}
              onChange={(event) => setEditMessageState((state) => (state ? { ...state, value: event.target.value } : state))}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-xl border border-border px-3 py-1.5 text-xs" onClick={() => setEditMessageState(null)}>
                {language === "en" ? "Cancel" : "取消"}
              </button>
              <button type="button" className="accent-button rounded-xl border px-3 py-1.5 text-xs" onClick={() => void submitEditMessage()}>
                {language === "en" ? "Save and rerun" : "保存并重新生成"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  const menu = contextMenu
    ? createPortal(
        <div
          className="fixed z-[120] min-w-[140px] rounded-xl border border-border bg-panel p-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="w-full rounded-lg px-3 py-2 text-left text-xs"
            onClick={() => openRenameDialog(contextMenu.id)}
          >
            {language === "en" ? "Rename" : "重命名"}
          </button>
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
    <section className="app-panel relative flex h-full min-w-0 flex-col overflow-hidden rounded border border-border">
      <header className="app-section-header flex items-center justify-between gap-2 border-b border-border p-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{t(language, "agent")}</div>
        </div>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-2 text-xs">
            <input type="checkbox" checked={hideCommandMessages} onChange={(event) => setSettings({ hideCommandMessages: event.target.checked })} />
            {language === "en" ? "Hide commands" : "隐藏指令"}
          </label>
          <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => createDialog()}>
            {t(language, "newDialog")}
          </button>
        </div>
      </header>

      <div className="border-b border-border px-2 py-2">
        <input
          className="mb-2 w-full rounded-xl border border-border px-3 py-2 text-xs"
          placeholder={language === "en" ? "Search dialogs" : "搜索对话"}
          value={dialogQuery}
          onChange={(event) => setDialogQuery(event.target.value)}
        />
        <div className="max-h-40 space-y-2 overflow-y-auto">
          {filteredDialogs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-3 py-3 text-xs text-slate-500">
              {language === "en" ? "No dialogs match this filter." : "没有匹配的对话。"}
            </div>
          ) : (
            filteredDialogs.map((dialog) => {
              const snippet = buildDialogSnippet(dialog);
              return (
                <button
                  key={dialog.id}
                  type="button"
                  className={`app-card w-full rounded-2xl border px-3 py-2 text-left text-xs ${dialog.id === activeDialogId ? "theme-active" : ""}`}
                  onClick={() => setActiveDialog(dialog.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const next = clampMenuPosition(event.clientX, event.clientY);
                    setContextMenu({ id: dialog.id, x: next.x, y: next.y });
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 truncate font-medium">{dialog.title}</div>
                    <div className="shrink-0 text-[11px] text-slate-500">{formatDialogTimestamp(dialog.updatedAt, language)}</div>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                    <span className="truncate">{snippet || (language === "en" ? "Empty dialog" : "空对话")}</span>
                    <span className="shrink-0">
                      {dialog.messages.length} {t(language, "msgs")}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div ref={messageListRef} className="min-h-0 min-w-0 flex-1 space-y-2 overflow-auto p-2">
        {visibleItems.length === 0 && (
          <div className="text-sm text-slate-500">
            {t(language, "startDialog")} <code>&gt;&gt;help</code>.
          </div>
        )}
        {visibleItems.map((item, index) =>
          item.kind === "command" ? (
            <div key={`${item.input.id}-${index}`} className="min-w-0 rounded-xl border border-border bg-white/40 p-3 text-sm dark:bg-slate-900/40">
              <div className="mb-2 text-xs font-semibold text-slate-500">{t(language, "command")}</div>
              {translationTask.active && item.output?.content === t(language, "running") && (
                <div className="app-progress-panel mb-2 rounded-lg px-3 py-2">
                  {translationTask.warning && <div className="app-progress-warning mb-2 text-xs">{translationTask.warning}</div>}
                  <div className="app-progress-meta mb-1 flex items-center justify-between text-[11px]">
                    <span>{translationTask.phase === "preparing" ? (language === "en" ? "Preparing translation" : "准备翻译") : language === "en" ? "Translation progress" : "翻译进度"}</span>
                    <span>{translationTask.completedPages}/{translationTask.totalPages || 0}</span>
                  </div>
                  <div className="app-progress-track">
                    <div
                      className="app-progress-fill transition-all"
                      style={{
                        width: `${translationTask.totalPages > 0 ? (translationTask.completedPages / translationTask.totalPages) * 100 : 0}%`,
                        background: "var(--accent-color)"
                      }}
                    />
                  </div>
                </div>
              )}
              <div className="rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs dark:bg-slate-950/70">{item.input.content}</div>
              <div className="mt-2 whitespace-pre-wrap rounded-lg border border-border px-3 py-2">{repairMojibake(item.output?.content ?? t(language, "running"))}</div>
            </div>
          ) : (
            <div key={item.message.id} className={`min-w-0 max-w-full rounded border px-2 py-2 text-sm ${item.message.role === "user" ? "agent-user-message" : "agent-ai-message"}`}>
              <div className="mb-1 text-xs text-slate-500">{item.message.role === "user" ? t(language, "user") : t(language, "assistant")}</div>
              {showThinking && item.message.reasoning && (
                <details className="thinking-panel mb-2 rounded border border-border px-2 py-1">
                  <summary className="cursor-pointer text-xs text-slate-500">{t(language, "thinking")}</summary>
                  <div className="mt-2 whitespace-pre-wrap text-xs">{repairMojibake(item.message.reasoning)}</div>
                </details>
              )}
              <article className="markdown-preview min-w-0 max-w-full text-sm">
                <RichMarkdown content={repairMojibake(item.message.content)} />
              </article>
              {item.message.role === "user" && (item.message.source ?? "chat") === "chat" ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-1 text-xs"
                    disabled={loading}
                    onClick={() => openEditMessage(item.message)}
                  >
                    {language === "en" ? "Edit" : "编辑"}
                  </button>
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-1 text-xs"
                    disabled={loading}
                    onClick={() => deleteUserTurn(item.message.id)}
                  >
                    {language === "en" ? "Delete" : "删除"}
                  </button>
                </div>
              ) : null}
              {canRegenerateMessage(sorted, item.message.id) && (
                <div className="mt-2 flex flex-wrap gap-2">
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
            tabIndex={0}
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
            onPaste={(event) => void handlePaste(event)}
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => void attachFile()}>
                {t(language, "addAttachment")}
              </button>
              <button type="button" className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50" disabled={!pdfPath} onClick={() => void addCurrentPdfPageAttachment()}>
                {language === "en" ? "Attach page" : "附加页面"}
              </button>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs"
                onClick={() => {
                  setAttachments([]);
                  logDrag("[AGENT] attachments cleared");
                }}
              >
                {attachmentBusy ? (language === "en" ? "Working..." : "处理中...") : language === "en" ? "Clear attachments" : "清除附件"}
              </button>
              <label className="inline-flex items-center gap-2 text-xs">
                <input type="checkbox" checked={includeProjectContextInChat} onChange={(event) => setSettings({ includeProjectContextInChat: event.target.checked })} />
                {t(language, "includeProjectContext")}
              </label>
            </div>
            <div className="text-xs text-slate-500">{attachmentBusy ? (language === "en" ? "Processing attachment..." : "正在处理附件...") : dragging ? t(language, "dropFilesActive") : (language === "en" ? `${t(language, "dropFiles")} | Press Ctrl+V here or in the input box to paste files/screenshots.` : `${t(language, "dropFiles")} | 可在此处或输入框中按 Ctrl+V 粘贴文件或截图。`)}</div>
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
          onPaste={(event) => void handlePaste(event)}
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
      {renameModal}
      {editModal}
    </section>
  );
}














