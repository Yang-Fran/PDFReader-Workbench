import type { ChatMessage } from "../types";

export type BeginnerGuideLanguage = "zh" | "en";

export const BEGINNER_COMMAND = ">>beginner";

const createMessage = (
  role: ChatMessage["role"],
  content: string,
  createdAt: number,
  source: ChatMessage["source"] = "command"
): ChatMessage => ({
  id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
  role,
  content,
  createdAt,
  source
});

export const getBeginnerDialogTitle = (language: BeginnerGuideLanguage) => (language === "en" ? "Getting started" : "新手上手");

export const buildBeginnerGuide = (language: BeginnerGuideLanguage) =>
  language === "en"
    ? [
        "Beginner guide: first steps",
        "",
        "1. Prepare an OpenAI-compatible API.",
        "   - Open Settings > LLM & API.",
        "   - Fill in Base URL, API Key, and Model.",
        "   - You can use a local runtime such as LM Studio or Ollama, or a cloud provider such as SiliconFlow or BigModel.",
        "",
        "2. Create and save a project.",
        "   - Click New project to reset the workspace.",
        "   - Click Save project to create a .pdfwb file.",
        "   - Add your PDF and Markdown files from the Files sidebar.",
        "",
        "3. Start reading and writing.",
        "   - Open a PDF and move to the target page.",
        "   - Run OCR when the page has no usable text layer.",
        "   - Run Translate to generate page translation.",
        "   - Keep notes in Markdown and insert selections, quotes, or AI replies.",
        "",
        "4. Use the Agent pane.",
        "   - Ask questions directly, or enter >>help to see commands.",
        "   - Common commands: >>tran, >>ocr, >>attach, >>refresh, >>beginner.",
        "",
        "5. Export notes when ready.",
        "   - Markdown preview and PDF export support math, HTML blocks, custom links, images, and attachments."
      ].join("\n")
    : [
        "入门指南：先这样开始",
        "",
        "1. 先准备一个兼容 OpenAI 的 API。",
        "   - 打开 设置 > LLM & API。",
        "   - 填写 Base URL、API Key 和 Model。",
        "   - 可以使用 LM Studio、Ollama 这类本地运行时，也可以使用 SiliconFlow、BigModel 这类云端服务。",
        "",
        "2. 新建并保存项目。",
        "   - 点击顶部的“新建项目”重置当前工作区。",
        "   - 再点击“保存项目”，生成一个 .pdfwb 项目文件。",
        "   - 之后从左侧 Files 栏加入 PDF 和 Markdown 文件。",
        "",
        "3. 开始阅读与记录。",
        "   - 打开 PDF，跳转到目标页。",
        "   - 如果页面没有可用文本层，先运行 OCR。",
        "   - 需要时运行 Translate 生成页面翻译。",
        "   - 在 Markdown 里整理笔记，并插入选中文本、PDF 引文或 AI 回复。",
        "",
        "4. 使用 Agent 面板。",
        "   - 可以直接提问，也可以输入 >>help 查看命令。",
        "   - 常用命令包括：>>tran、>>ocr、>>attach、>>refresh、>>beginner。",
        "",
        "5. 需要时导出笔记。",
        "   - 当前 Markdown 预览和 PDF 导出支持公式、HTML 块、自定义链接、图片和附件。"
      ].join("\n");

export const createBeginnerGuideMessages = (language: BeginnerGuideLanguage): ChatMessage[] => {
  const now = Date.now();
  return [createMessage("user", BEGINNER_COMMAND, now), createMessage("assistant", buildBeginnerGuide(language), now + 1)];
};
