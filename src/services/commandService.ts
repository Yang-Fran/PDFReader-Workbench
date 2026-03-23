import { invoke } from "@tauri-apps/api/core";
import { buildBeginnerGuide } from "./beginnerGuide";
import { llmService } from "./llmService";
import { projectService } from "./projectService";
import { workspaceService } from "./workspaceService";
import { useAppStore } from "../stores/appStore";
import { ChatMessage, TranslationExecutionMode } from "../types";

const STREAM_TRANSLATION_PAGE_LIMIT = 45;

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

const createMessage = (
  role: ChatMessage["role"],
  content: string,
  source: ChatMessage["source"] = "chat"
): ChatMessage => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  role,
  content,
  createdAt: Date.now(),
  source
});

const emit = (name: string, detail?: unknown) => {
  window.dispatchEvent(new CustomEvent(name, { detail }));
};

const getLanguage = () => useAppStore.getState().settings.language;
const text = (zh: string, en: string) => (getLanguage() === "en" ? en : zh);
const lines = (...items: Array<[string, string] | string>) =>
  items
    .map((item) => (typeof item === "string" ? item : text(item[0], item[1])))
    .join("\n");

const parsePageExpression = (parts: string[], totalPages: number, currentPage: number) => {
  const normalized = parts.join("").replace(/\s+/g, "");
  if (!normalized) return [currentPage];

  const pages = new Set<number>();
  for (const token of normalized.split("|")) {
    if (!token) continue;
    if (/^\d+$/.test(token)) {
      const page = Number(token);
      if (page >= 1 && page <= totalPages) pages.add(page);
      continue;
    }

    const range = token.match(/^(\d+)-(\d+)$/);
    if (!range) continue;
    const start = Math.min(Number(range[1]), Number(range[2]));
    const end = Math.max(Number(range[1]), Number(range[2]));
    for (let page = start; page <= end; page += 1) {
      if (page >= 1 && page <= totalPages) pages.add(page);
    }
  }

  return [...pages].sort((a, b) => a - b);
};

const parseTranslationOptions = (args: string[], settingsStreamingEnabled: boolean) => {
  const modeToken = args.find((item) => /^(stream|expli)$/i.test(item))?.toLowerCase();
  const force = args.some((item) => /^force$/i.test(item));
  const mode: TranslationExecutionMode =
    modeToken === "expli" ? "expli" : modeToken === "stream" ? "stream" : settingsStreamingEnabled ? "stream" : "expli";
  const pageArgs = args.filter((item) => !/^(stream|expli|force)$/i.test(item));
  return { mode, force, pageArgs };
};

const loadPdfTexts = async (
  pages: number[],
  store: ReturnType<typeof useAppStore.getState>,
  onPageReady?: (completedPages: number) => void
) => {
  if (!store.pdfPath || pages.length === 0) return new Map<number, string>();

  const cached = new Map<number, string>();
  const missingPages: number[] = [];

  for (const page of pages) {
    const cachedText = store.pageTextCache[page] ?? (page === store.currentPage ? store.currentPageText : "");
    if (cachedText.trim()) {
      cached.set(page, cachedText.trim());
    } else {
      missingPages.push(page);
    }
  }

  if (missingPages.length === 0) return cached;

  const pdfjs = await getPdfJs();
  const bytes = new Uint8Array(await invoke<number[]>("read_binary_file", { path: store.pdfPath }));
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  let completed = pages.length - missingPages.length;

  for (const page of missingPages) {
    if (page < 1 || page > doc.numPages) continue;
    const pdfPage = await doc.getPage(page);
    const textContent = await pdfPage.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    useAppStore.getState().setPageTextCache(page, pageText);
    if (pageText) cached.set(page, pageText);
    completed += 1;
    onPageReady?.(completed);
  }

  return cached;
};

type CommandContext = {
  args: string[];
  store: ReturnType<typeof useAppStore.getState>;
};

type CommandSpec = {
  name: string;
  summary: [string, string];
  detail?: () => string;
  execute?: (context: CommandContext) => Promise<string> | string;
};

const beginnerText = () => buildBeginnerGuide(getLanguage()) ||
  lines(
    ["入门指南：快速开始", "Beginner guide: quick start"],
    ["1. 用左侧文件区导入或挂载 PDF 与 Markdown。", "1. Use the left file sidebar to import or mount PDF and Markdown files."],
    ["2. 打开 PDF 后，翻页会同步 OCR、翻译和当前阅读上下文。", "2. After opening a PDF, paging keeps OCR, translation, and reading context in sync."],
    ["3. 用 Markdown 记录笔记、引用原文，并保留 AI 回复。", "3. Use Markdown to keep notes, quotes, and AI replies together."],
    ["4. 在 Agent 中直接提问，或输入 >>help 查看可用指令。", "4. Ask questions in Agent directly, or enter >>help to view commands."],
    ["5. 常用指令包括 >>tran、>>ocr、>>attach、>>refresh、>>clear、>>prev。", "5. Common commands include >>tran, >>ocr, >>attach, >>refresh, >>clear, and >>prev."],
    ["6. 保存项目时，Markdown、翻译缓存和 Agent 缓存会一起持久化。", "6. Saving the project persists Markdown, translation cache, and Agent cache together."]
  );

const commandRegistry: CommandSpec[] = [
  {
    name: "help",
    summary: [">>help：显示命令帮助", ">>help: show command help"]
  },
  {
    name: "ocr",
    summary: [">>ocr [page]/help：OCR 指令", ">>ocr [page]/help: OCR command"],
    detail: () =>
      lines(
        ["基础命令：说明", "Basic commands: description"],
        [">>ocr：对当前页执行 OCR", ">>ocr: run OCR on the current page"],
        [">>ocr 8：跳到第 8 页并执行 OCR", ">>ocr 8: jump to page 8 and run OCR"],
        [">>ocr help：显示 OCR 帮助", ">>ocr help: show OCR help"]
      ),
    execute: async ({ args, store }) => {
      const arg = (args[0] ?? "").toLowerCase();
      if (arg === "help") return getHelpText("ocr");
      const page = args.length > 0 && /^\d+$/.test(args[0]) ? Number(args[0]) : store.currentPage;
      if (!page || page < 1 || page > store.totalPages) {
        return text("基础命令：无效页码", "Basic command: invalid page number");
      }
      emit("agent:ocr-request", { page });
      return text(`基础命令：已开始对第 ${page} 页执行 OCR`, `Basic command: started OCR for page ${page}`);
    }
  },
  {
    name: "tran",
    summary: [">>tran [page|range] [stream|expli] [force]/help/state：翻译指令", ">>tran [page|range] [stream|expli] [force]/help/state: translation command"],
    detail: () =>
      lines(
        ["基础命令：说明", "Basic commands: description"],
        [">>tran：翻译当前页，模式默认跟随设置（默认 stream）", ">>tran: translate the current page; mode follows settings by default (stream by default)"],
        [">>tran 8 stream：流式翻译第 8 页", ">>tran 8 stream: translate page 8 with streaming"],
        [">>tran 3-5|8 expli：非流式翻译指定页面", ">>tran 3-5|8 expli: translate selected pages without streaming"],
        [">>tran 12 force：忽略已有缓存，强制重译第 12 页", ">>tran 12 force: ignore cache and force retranslation for page 12"],
        [">>tran state：查看翻译队列与进行中状态", ">>tran state: show translation queue and running state"],
        [`stream 模式单次最多处理前 ${STREAM_TRANSLATION_PAGE_LIMIT} 页；完整大批量翻译建议使用 expli。`, `In stream mode, each run processes at most the first ${STREAM_TRANSLATION_PAGE_LIMIT} pages; use expli for large full-range jobs.`],
        ["未添加 force 时会优先命中缓存，并在结果里说明缓存命中页。", "Without force, cached translations are reused and reported in the result."],
        [">>tran help：显示翻译帮助", ">>tran help: show translation help"]
      ),
    execute: async ({ args, store }) => {
      const arg = (args[0] ?? "").toLowerCase();
      if (arg === "help") return getHelpText("tran");
      if (arg === "state") {
        const translating = Object.entries(store.pageTranslationStatus)
          .filter(([, status]) => status === "translating")
          .map(([page]) => Number(page))
          .sort((a, b) => a - b);
        const queued = [...store.translationQueue];
        return text(
          `翻译状态：queued=[${queued.join(",") || "-"}] running=[${translating.join(",") || "-"}]`,
          `Translation state: queued=[${queued.join(",") || "-"}] running=[${translating.join(",") || "-"}]`
        );
      }

      const { mode, force, pageArgs } = parseTranslationOptions(args, store.settings.enableTranslationStreaming);
      const requestedPages = parsePageExpression(pageArgs, store.totalPages, store.currentPage);
      const pages = mode === "stream" ? requestedPages.slice(0, STREAM_TRANSLATION_PAGE_LIMIT) : requestedPages;
      if (pages.length === 0) {
        return text("基础命令：没有可翻译的有效页码", "Basic command: no valid pages to translate");
      }

      const warningParts: string[] = [];
      if (mode === "stream" && requestedPages.length >= 12) {
        warningParts.push(text("翻译文本量较大，流式输出可能会引发卡顿。", "Large translation jobs may stutter with streaming output."));
      }
      if (mode === "stream" && requestedPages.length > STREAM_TRANSLATION_PAGE_LIMIT) {
        warningParts.push(
          text(
            `本次 stream 仅处理前 ${STREAM_TRANSLATION_PAGE_LIMIT} 页；如需完整翻译，请使用 >>tran ... expli。`,
            `This stream run only processes the first ${STREAM_TRANSLATION_PAGE_LIMIT} pages. Use >>tran ... expli for the full range.`
          )
        );
      }
      if (!force) {
        warningParts.push(
          text("未指定 force，系统会优先复用已有翻译缓存。", "force was not specified, so existing translation cache will be reused first.")
        );
      }

      useAppStore.getState().setTranslationTask({
        active: true,
        phase: "preparing",
        completedPages: 0,
        totalPages: pages.length,
        mode,
        warning: warningParts.join("\n")
      });

      const textMap = await loadPdfTexts(pages, store, (completed) => {
        useAppStore.getState().setTranslationTask({ completedPages: completed });
      });

      const translatedPages: number[] = [];
      const cacheHitPages: number[] = [];
      const missingTextPages: number[] = [];

      useAppStore.getState().setTranslationTask({ phase: "translating", completedPages: 0 });

      try {
        for (const page of pages) {
          const latest = useAppStore.getState();
          const textValue = textMap.get(page) ?? "";
          const cachedTranslation = latest.pageTranslationCache[page]?.trim() ?? "";

          if (!textValue) {
            missingTextPages.push(page);
            latest.setTranslationTask({ completedPages: translatedPages.length + cacheHitPages.length + missingTextPages.length });
            continue;
          }

          if (!force && cachedTranslation) {
            latest.setPageTranslationStatus(page, "done");
            if (latest.currentPage === page) latest.setCurrentPageTranslation(cachedTranslation);
            cacheHitPages.push(page);
            latest.setTranslationTask({ completedPages: translatedPages.length + cacheHitPages.length + missingTextPages.length });
            continue;
          }

          latest.setPageTranslationStatus(page, "translating");
          latest.setPageTranslationCache(page, "");

          try {
            let streamedTranslation = "";
            const result = await llmService.translatePageByMode(textValue, mode, {
              onToken: (token) => {
                streamedTranslation += token;
                const snapshot = useAppStore.getState();
                snapshot.setPageTranslationCache(page, streamedTranslation);
                if (snapshot.currentPage === page) snapshot.setCurrentPageTranslation(streamedTranslation);
              }
            });

            const snapshot = useAppStore.getState();
            snapshot.setPageTranslationCache(page, result);
            snapshot.setPageTranslationStatus(page, "done");
            if (snapshot.currentPage === page) snapshot.setCurrentPageTranslation(result);
            translatedPages.push(page);
          } catch (error) {
            useAppStore.getState().setPageTranslationStatus(page, "error");
            throw error;
          } finally {
            useAppStore.getState().setTranslationTask({
              completedPages: translatedPages.length + cacheHitPages.length + missingTextPages.length
            });
          }
        }
      } finally {
        useAppStore.getState().resetTranslationTask();
      }

      emit("agent:refresh", { target: "pdf" });

      const resultParts = [
        warningParts.join("\n"),
        translatedPages.length
          ? text(`已翻译页面：${translatedPages.join(", ")}`, `Translated pages: ${translatedPages.join(", ")}`)
          : "",
        cacheHitPages.length
          ? text(`命中缓存页面：${cacheHitPages.join(", ")}`, `Cache hit pages: ${cacheHitPages.join(", ")}`)
          : "",
        missingTextPages.length
          ? text(`以下页面未提取到文本，已跳过：${missingTextPages.join(", ")}`, `Skipped pages with no extracted text: ${missingTextPages.join(", ")}`)
          : ""
      ].filter(Boolean);

      if (translatedPages.length === 0 && cacheHitPages.length === 0) {
        return text("基础命令：没有可用页面文本，无法执行翻译", "Basic command: no page text available for translation");
      }

      return resultParts.join("\n");
    }
  },
  {
    name: "attach",
    summary: [">>attach [page|range]/help：附加 PDF 页面", ">>attach [page|range]/help: attach PDF pages"],
    detail: () =>
      lines(
        ["基础命令：说明", "Basic commands: description"],
        [">>attach：附加当前页", ">>attach: attach the current page"],
        [">>attach 8：附加第 8 页", ">>attach 8: attach page 8"],
        [">>attach 3-5|8：附加第 3 到 5 页以及第 8 页", ">>attach 3-5|8: attach pages 3 to 5 and page 8"],
        [">>attach help：显示附加帮助", ">>attach help: show attachment help"]
      )
  },
  {
    name: "rename",
    summary: [">>rename [new name]：重命名当前对话", ">>rename [new name]: rename the current dialog"],
    detail: () =>
      lines(
        ["基础命令：说明", "Basic commands: description"],
        [">>rename 电路分析：将当前对话重命名为“电路分析”", ">>rename Circuit study: rename the current dialog to \"Circuit study\""],
        [">>rename help：显示重命名帮助", ">>rename help: show rename help"]
      ),
    execute: ({ args, store }) => {
      const title = args.join(" ").trim();
      if (!title || title.toLowerCase() === "help") return getHelpText("rename");
      store.renameDialog(store.activeDialogId, title);
      return text(`基础命令：已将当前对话重命名为“${title}”`, `Basic command: renamed the current dialog to "${title}"`);
    }
  },
  {
    name: "new",
    summary: [">>new (proj/dialog/md) [optional name]：创建内容", ">>new (proj/dialog/md) [optional name]: create content"],
    detail: () =>
      lines(
        ["基础命令：说明", "Basic commands: description"],
        [">>new proj：创建新项目", ">>new proj: create a new project"],
        [">>new dialog [name]：创建新对话", ">>new dialog [name]: create a new dialog"],
        [">>new md [name]：清空并重命名 Markdown", ">>new md [name]: reset and rename Markdown"],
        [">>new help：显示创建帮助", ">>new help: show create help"]
      ),
    execute: async ({ args, store }) => {
      const target = (args[0] ?? "").toLowerCase();
      const extraName = args.slice(1).join(" ").trim();
      if (!target || target === "help") return getHelpText("new");

      if (target === "proj") {
        await projectService.newProject();
        return text("基础命令：已创建新项目", "Basic command: created a new project");
      }

      if (target === "dialog") {
        store.createDialog(extraName || undefined);
        return text(
          `基础命令：已创建新对话${extraName ? `（${extraName}）` : ""}`,
          `Basic command: created a new dialog${extraName ? ` (${extraName})` : ""}`
        );
      }

      if (target === "md") {
        store.setNotes("");
        store.setNotesFilePath(extraName || "");
        return text(
          `基础命令：已新建 Markdown${extraName ? `（${extraName}）` : ""}`,
          `Basic command: created Markdown${extraName ? ` (${extraName})` : ""}`
        );
      }

      return getHelpText("new");
    }
  },
  {
    name: "open",
    summary: [">>open：打开添加文件对话框", ">>open: open the add-files dialog"],
    execute: async () => {
      emit("agent:show-files");
      emit("agent:add-workspace-files");
      return text("基础命令：已打开添加文件对话框", "Basic command: opened the add-files dialog");
    }
  },
  {
    name: "del",
    summary: [">>del：删除当前对话", ">>del: delete the current dialog"],
    execute: ({ store }) => {
      const currentId = store.activeDialogId;
      if (store.dialogs.length <= 1) {
        store.createDialog();
      }
      useAppStore.getState().deleteDialog(currentId);
      return text("基础命令：已删除当前对话", "Basic command: deleted the current dialog");
    }
  },
  {
    name: "clear",
    summary: [">>clear：清空当前上下文", ">>clear: clear the current context"],
    execute: ({ store }) => {
      store.clearMessages(store.activeDialogId);
      store.setAttachments([]);
      store.setLastAIReply("");
      return text("基础命令：已清空当前对话上下文和附件", "Basic command: cleared the current dialog context and attachments");
    }
  },
  {
    name: "prev",
    summary: [">>prev：重复上一条操作", ">>prev: repeat the previous action"]
  },
  {
    name: "refresh",
    summary: [">>refresh [pdf|md|agent|cache]：刷新内容", ">>refresh [pdf|md|agent|cache]: refresh content"],
    execute: async ({ args, store }) => {
      const target = (args[0] ?? "").toLowerCase();
      if (!target || !["pdf", "md", "agent", "cache"].includes(target)) {
        return text("基础命令：用法 >>refresh pdf|md|agent|cache", "Basic command: usage >>refresh pdf|md|agent|cache");
      }
      if (target === "cache" && store.projectPath) {
        await workspaceService.syncProjectCaches(store.projectPath);
      }
      emit("agent:refresh", { target });
      return text(`基础命令：已刷新 ${target}`, `Basic command: refreshed ${target}`);
    }
  },
  {
    name: "beginner",
    summary: [">>beginner：显示入门指南", ">>beginner: show a beginner guide"],
    execute: async () => beginnerText()
  },
  {
    name: "quit",
    summary: [">>quit：退出应用", ">>quit: quit the app"],
    execute: async () => {
      await invoke("quit_app");
      return text("基础命令：正在退出应用", "Basic command: quitting the app");
    }
  }
];

const registryByName = new Map(commandRegistry.map((item) => [item.name, item]));

const getHelpText = (name?: string) => {
  if (!name || name === "help") {
    return lines(["基础命令：说明", "Basic commands: description"], ...commandRegistry.map((item) => item.summary));
  }
  return registryByName.get(name)?.detail?.() ?? lines(["基础命令：没有更多帮助信息", "Basic command: no additional help available"]);
};

export const commandService = {
  getHelpText,
  parsePageExpression,
  async execute(input: string): Promise<string> {
    const trimmed = input.trim();
    const normalized = trimmed.replace(/^>>/, "").trim();
    const [rawName = "", ...args] = normalized.split(/\s+/);
    const name = rawName.toLowerCase();
    const store = useAppStore.getState();

    if (!name || name === "help") return getHelpText();

    const command = registryByName.get(name);
    if (!command) {
      return text("基础命令：未知指令，输入 >>help 查看帮助", "Basic command: unknown command, enter >>help for help");
    }

    if (!command.execute) {
      return command.detail?.() ?? getHelpText(name);
    }

    return command.execute({ args, store });
  },
  createMessage
};
