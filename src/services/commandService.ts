import { invoke } from "@tauri-apps/api/core";
import { llmService } from "./llmService";
import { projectService } from "./projectService";
import { workspaceService } from "./workspaceService";
import { useAppStore } from "../stores/appStore";
import { ChatMessage } from "../types";

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
    .map((item) => {
      if (typeof item === "string") return item;
      return text(item[0], item[1]);
    })
    .join("\n");

const helpText = () =>
  lines(
    ["基础指令：说明", "Basic commands: description"],
    [">>help：查看指令帮助", ">>help: show command help"],
    [">>ocr [页面]/help：OCR 指令", ">>ocr [page]/help: OCR command"],
    [">>tran [页面|范围]/help/state：翻译指令", ">>tran [page|range]/help/state: translation command"],
    [">>new (proj/dialog/md) [名称]：新建内容", ">>new (proj/dialog/md) [name]: create content"],
    [">>open：拉起添加文件对话框", ">>open: open the add-files dialog"],
    [">>file：显示或聚焦文件栏", ">>file: show or focus the file sidebar"],
    [">>del：删除当前对话", ">>del: delete the current dialog"],
    [">>clear：清除当前上下文", ">>clear: clear the current context"],
    [">>refresh [pdf|md|agent|cache]：刷新内容", ">>refresh [pdf|md|agent|cache]: refresh content"],
    [">>beginner：查看新手教程", ">>beginner: show a beginner guide"],
    [">>quit：退出软件", ">>quit: quit the app"]
  );

const ocrHelpText = () =>
  lines(
    ["基础指令：说明", "Basic commands: description"],
    [">>ocr：对当前页执行 OCR", ">>ocr: run OCR on the current page"],
    [">>ocr 8：跳到第 8 页并执行 OCR", ">>ocr 8: jump to page 8 and run OCR"],
    [">>ocr help：查看 OCR 帮助", ">>ocr help: show OCR help"]
  );

const tranHelpText = () =>
  lines(
    ["基础指令：说明", "Basic commands: description"],
    [">>tran：翻译当前页", ">>tran: translate the current page"],
    [">>tran 8：翻译第 8 页", ">>tran 8: translate page 8"],
    [">>tran 3-5：翻译第 3 到 5 页", ">>tran 3-5: translate pages 3 to 5"],
    [">>tran help：查看翻译帮助", ">>tran help: show translation help"]
  );

const newHelpText = () =>
  lines(
    ["基础指令：说明", "Basic commands: description"],
    [">>new proj：新建项目", ">>new proj: create a new project"],
    [">>new dialog [名称]：新建对话", ">>new dialog [name]: create a new dialog"],
    [">>new md [名称]：清空并命名 Markdown", ">>new md [name]: reset and rename Markdown"],
    [">>new help：查看新建帮助", ">>new help: show create help"]
  );

const beginnerText = () =>
  lines(
    ["新手教程：快速开始", "Beginner guide: quick start"],
    ["1. 用左侧文件栏导入或挂载 PDF 和 Markdown 文件。", "1. Use the left sidebar to import or mount PDF and Markdown files."],
    ["2. 打开 PDF 后，滚动页面会自动同步翻译队列。", "2. After opening a PDF, scrolling pages keeps the translation queue in sync."],
    ["3. 在 Markdown 区可插入选中文本、引用块和 AI 回复。", "3. In Markdown you can insert selections, quote blocks, and AI replies."],
    ["4. 在 Agent 输入框输入普通问题即可对话，输入 >>help 可查看指令。", "4. Ask normal questions in Agent, or enter >>help to see commands."],
    ["5. 常用指令：>>tran、>>ocr、>>refresh、>>clear。", "5. Common commands: >>tran, >>ocr, >>refresh, >>clear."],
    ["6. 记得保存项目，程序会一起保存 Markdown 和缓存索引。", "6. Save the project to persist Markdown and cache indexes together."]
  );

const parsePages = (parts: string[], totalPages: number, currentPage: number) => {
  const pages = new Set<number>();
  if (parts.length === 0) {
    pages.add(currentPage);
    return [...pages];
  }

  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      const page = Number(part);
      if (page >= 1 && page <= totalPages) pages.add(page);
      continue;
    }

    const range = part.match(/^(\d+)-(\d+)$/);
    if (!range) continue;
    const start = Math.min(Number(range[1]), Number(range[2]));
    const end = Math.max(Number(range[1]), Number(range[2]));
    for (let page = start; page <= end; page += 1) {
      if (page >= 1 && page <= totalPages) pages.add(page);
    }
  }

  return [...pages].sort((a, b) => a - b);
};

export const commandService = {
  async execute(input: string): Promise<string> {
    const trimmed = input.trim();
    const normalized = trimmed.replace(/^>>/, "").trim();
    const [rawName = "", ...rest] = normalized.split(/\s+/);
    const name = rawName.toLowerCase();
    const store = useAppStore.getState();

    if (!name || name === "help") return helpText();

    if (name === "quit") {
      await invoke("quit_app");
      return text("基础指令：程序正在退出", "Basic command: quitting the app");
    }

    if (name === "beginner") {
      return beginnerText();
    }

    if (name === "open") {
      emit("agent:show-files");
      emit("agent:add-workspace-files");
      return text("基础指令：已打开添加文件对话框", "Basic command: opened the add-files dialog");
    }

    if (name === "file") {
      emit("agent:show-files");
      return text("基础指令：已显示文件栏", "Basic command: showed the file sidebar");
    }

    if (name === "clear") {
      store.clearMessages(store.activeDialogId);
      store.setAttachments([]);
      store.setLastAIReply("");
      return text("基础指令：已清除当前对话上下文和附件", "Basic command: cleared the current dialog context and attachments");
    }

    if (name === "del") {
      const currentId = store.activeDialogId;
      if (store.dialogs.length <= 1) {
        store.createDialog();
      }
      useAppStore.getState().deleteDialog(currentId);
      return text("基础指令：已删除当前对话", "Basic command: deleted the current dialog");
    }

    if (name === "new") {
      const target = (rest[0] ?? "").toLowerCase();
      const extraName = rest.slice(1).join(" ").trim();
      if (!target || target === "help") return newHelpText();

      if (target === "proj") {
        await projectService.newProject();
        return text("基础指令：已新建项目", "Basic command: created a new project");
      }

      if (target === "dialog") {
        store.createDialog(extraName || undefined);
        return text(`基础指令：已新建对话${extraName ? ` (${extraName})` : ""}`, `Basic command: created a new dialog${extraName ? ` (${extraName})` : ""}`);
      }

      if (target === "md") {
        store.setNotes("");
        store.setNotesFilePath(extraName || "");
        return text(`基础指令：已新建 Markdown${extraName ? ` (${extraName})` : ""}`, `Basic command: created Markdown${extraName ? ` (${extraName})` : ""}`);
      }

      return newHelpText();
    }

    if (name === "ocr") {
      const arg = (rest[0] ?? "").toLowerCase();
      if (arg === "help") return ocrHelpText();
      const page = rest.length > 0 && /^\d+$/.test(rest[0]) ? Number(rest[0]) : store.currentPage;
      if (!page || page < 1 || page > store.totalPages) {
        return text("基础指令：页码无效", "Basic command: invalid page number");
      }
      emit("agent:ocr-request", { page });
      return text(`基础指令：已对第 ${page} 页发起 OCR`, `Basic command: started OCR for page ${page}`);
    }

    if (name === "tran") {
      const arg = (rest[0] ?? "").toLowerCase();
      if (arg === "help") return tranHelpText();
      if (arg === "state") {
        const translating = Object.entries(store.pageTranslationStatus)
          .filter(([, status]) => status === "translating")
          .map(([page]) => Number(page))
          .sort((a, b) => a - b);
        const queued = [...store.translationQueue];
        return text(
          `翻译状态：排队=[${queued.join(",") || "-"}] 进行中=[${translating.join(",") || "-"}]`,
          `Translation state: queued=[${queued.join(",") || "-"}] running=[${translating.join(",") || "-"}]`
        );
      }

      const pages = parsePages(rest, store.totalPages, store.currentPage);
      if (pages.length === 0) {
        return text("基础指令：没有可翻译的有效页码", "Basic command: no valid pages to translate");
      }

      const completedPages: number[] = [];
      for (const page of pages) {
        const latest = useAppStore.getState();
        const textValue = latest.pageTextCache[page] ?? (page === latest.currentPage ? latest.currentPageText : "");
        if (!textValue) continue;

        latest.setPageTranslationStatus(page, "translating");
        latest.setPageTranslationCache(page, "");

        let streamedTranslation = "";
        const translated = await llmService.translatePageStream(textValue, {
          onToken: (token) => {
            streamedTranslation += token;
            const snapshot = useAppStore.getState();
            snapshot.setPageTranslationCache(page, streamedTranslation);
            if (snapshot.currentPage === page) snapshot.setCurrentPageTranslation(streamedTranslation);
          }
        });

        const snapshot = useAppStore.getState();
        snapshot.setPageTranslationCache(page, translated);
        snapshot.setPageTranslationStatus(page, "done");
        if (snapshot.currentPage === page) snapshot.setCurrentPageTranslation(translated);
        completedPages.push(page);
      }

      emit("agent:refresh", { target: "pdf" });

      if (completedPages.length === 0) {
        return text("基础指令：没有可翻译的页面文本", "Basic command: no page text available for translation");
      }

      return text(
        `基础指令：已完成翻译页面 ${completedPages.join(", ")}`,
        `Basic command: translated pages ${completedPages.join(", ")}`
      );
    }

    if (name === "refresh") {
      const target = (rest[0] ?? "").toLowerCase();
      if (!target || !["pdf", "md", "agent", "cache"].includes(target)) {
        return text(
          "基础指令：用法 >>refresh pdf|md|agent|cache",
          "Basic command: usage >>refresh pdf|md|agent|cache"
        );
      }

      if (target === "cache") {
        if (store.projectPath) {
          await workspaceService.syncProjectCaches(store.projectPath);
        }
      }

      emit("agent:refresh", { target });
      return text(`基础指令：已刷新 ${target}`, `Basic command: refreshed ${target}`);
    }

    return text("基础指令：未知指令，输入 >>help 查看帮助", "Basic command: unknown command, enter >>help for help");
  },

  createMessage
};
