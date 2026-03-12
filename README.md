# PDF Reader Workbench

PDF Reader Workbench 是一个面向论文阅读、翻译、笔记整理和 AI 辅助分析的桌面工具。项目基于 Tauri 2、React 18、TypeScript 和 Vite 构建，当前主要面向 Windows 桌面环境。

它把 PDF 阅读、OCR、逐页翻译、Markdown 笔记和多轮 Agent 对话放进同一个工作区中，并通过 `.pdfwb` 项目文件保存项目结构，再把翻译缓存和 Agent 上下文分别存入独立 cache 目录，便于长期维护和恢复。

## 主要特性

- 本地 PDF 打开、渲染、缩放、页码跳转
- PDF 打开进度显示
- 原生文本层提取，缺失时可调用 OCR
- 基于 OpenAI 兼容接口的逐页翻译，支持流式输出
- 翻译请求默认带 `enable_thinking: false`，以降低等待时间
- Markdown 编辑与预览，支持 GFM、KaTeX、代码块与引用块
- 支持将 PDF 引文插入 Markdown，并从引用跳回原 PDF 页面
- 右侧 AI Agent 支持多对话、多附件、Markdown 渲染回复
- 支持把当前 PDF 文本、Markdown 内容、附件文件一起送入 Agent 上下文
- 支持拖拽附件到 Agent 附件区
- 支持项目文件 `.pdfwb` 保存与恢复
- 支持 `translation_cache` 与 `llm_cache` 独立管理
- 支持中文 / English 界面切换

## 界面结构

- 左侧：可折叠文件栏，显示项目内 PDF / Markdown 与外部挂载文件
- 中间：PDF 阅读区与翻译区
- 下方或中部：Markdown 编辑与预览区
- 右侧：AI Agent 对话区
- 设置页：LLM 配置、语言切换、缓存管理、提示词配置

## 开发快速入门

### 1. 安装依赖

确保本机具备以下环境：

- Node.js 18+
- Rust stable
- Windows 桌面构建所需的 Tauri / WebView2 环境

安装前端依赖：

```powershell
npm install
```

### 2. 开发模式启动

```powershell
npm run tauri:dev
```

如果只需要跑前端：

```powershell
npm run dev
```

### 3. 生产构建

前端构建：

```powershell
npm run build
```

Tauri 打包：

```powershell
npm run tauri:build
```

Windows 安装包默认输出位置：

- `src-tauri/target/release/bundle/nsis/`
- `src-tauri/target/release/bundle/msi/`

## 使用说明

### 项目与文件

- 可以新建项目，再向文件栏中添加 PDF 或 Markdown 文件
- 项目内文件与外部挂载文件会分开展示
- 双击 `.pdfwb` 文件可以启动应用并自动打开项目

### 翻译与 OCR

- 打开 PDF 后，可按当前页面读取文本或执行 OCR
- 翻译结果按 PDF 独立缓存，不同 PDF 不会共用同一份翻译状态
- 切换 PDF 时，会自动恢复该 PDF 对应的翻译缓存

### Markdown 笔记

- 支持手动编辑 Markdown
- 可插入选中文本、最近一次 AI 回复或 PDF 引用块
- 引用块可回跳到对应 PDF 页面

### AI Agent

- 支持多对话管理
- 输入框支持多行输入
- `Enter` 发送，`Shift+Enter` 换行
- 支持将文本文件和 PDF 作为附件加入上下文
- 回复支持 Markdown 渲染

## 指令集

Agent 输入框支持 `>>` 指令，当前支持：

- `>>help`
- `>>ocr [page]`
- `>>ocr help`
- `>>tran [page|range]`
- `>>tran help`
- `>>tran state`
- `>>new proj`
- `>>new dialog [name]`
- `>>new md [name]`
- `>>open`
- `>>file`
- `>>del`
- `>>clear`
- `>>refresh pdf|md|agent|cache`
- `>>beginner`
- `>>quit`

说明：

- 指令不区分大小写
- help 与大部分指令输出支持双语

## LLM 配置

项目通过 OpenAI 兼容的 `/chat/completions` 接口进行对话和翻译。

支持的配置项包括：

- Base URL
- API Key
- Model
- Chat system prompt
- Translation prompt
- Glossary / 术语表

接口路径解析规则：

- 若 Base URL 已以 `/chat/completions` 结尾，则直接使用
- 若以 `/v1` 结尾，则自动补 `/chat/completions`
- 若仅提供源站地址，则默认使用 `/v1/chat/completions`
- 若已包含自定义路径，则在后方补 `/chat/completions`，不强制改写为 `/v1`

网络请求回退链路：

1. 浏览器 `fetch`
2. Rust 代理命令 `llm_chat_proxy`
3. Tauri HTTP 插件

注意：

- 对话和翻译都会调用外部 API，可能产生费用
- API Key 不会写入 `.pdfwb` 项目文件

## 项目文件与缓存

### `.pdfwb` 项目文件

`.pdfwb` 文件保存的是轻量项目快照，不直接保存全部缓存正文。当前快照版本为 `v3`，向后兼容旧版本导入。

项目文件主要记录：

- 当前 PDF 路径与名称
- 当前页码与视图模式
- Markdown 内容与当前 Markdown 路径
- 文件栏索引
- 当前对话 ID
- cache 索引信息
- LLM 基础配置

### 缓存目录

项目文件同级会创建两个目录：

- `translation_cache`
- `llm_cache`

其中：

- `translation_cache` 按 PDF 分文件保存翻译状态
- `llm_cache` 保存多对话内容和项目级 Agent 状态
- 在设置页中可以查看缓存文件大小并执行清理
- 清理 cache 时，会同时清理内存状态并刷新相关区域

## 项目结构

```text
src/
  components/
    agent/
    files/
    notes/
    pdf/
    settings/
  services/
  stores/
  types.ts
src-tauri/
  src/lib.rs
  tauri.conf.json
pre-input.txt
package.json
```

关键文件：

- `src/App.tsx`：应用框架与主要布局
- `src/stores/appStore.ts`：全局状态与项目会话状态
- `src/components/pdf/PdfPane.tsx`：PDF 阅读、翻译联动、页码控制
- `src/components/notes/NotesPane.tsx`：Markdown 编辑与预览
- `src/components/agent/AgentPane.tsx`：多对话 Agent 与附件管理
- `src/components/files/FileSidebar.tsx`：项目文件栏
- `src/components/settings/SettingsPanel.tsx`：设置与缓存管理
- `src/services/llmService.ts`：LLM 请求封装
- `src/services/projectService.ts`：项目保存与读取
- `src/services/workspaceService.ts`：cache 构建与工作区管理
- `src-tauri/src/lib.rs`：Tauri 后端命令与本地文件能力

## Release

当前版本：`v2.1.0`

当前 release 产物路径：

- `src-tauri/target/release/bundle/nsis/PDF Reader Workbench_2.1.0_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/PDF Reader Workbench_2.1.0_x64_en-US.msi`

## 已知事项

- 前端 bundle 仍然偏大，Vite 会给出 chunk size 警告
- 部分本地模型服务若自身 prompt template 有问题，可能会影响 Agent 对话

## License

本项目使用 [MIT License](./LICENSE)。

## Contributing

欢迎提交 issue 和 pull request。贡献说明见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
