# PDF Reader Workbench

PDF Reader Workbench 是一个面向论文阅读、翻译、笔记整理和 AI 辅助分析的桌面应用。它将 PDF 阅读、OCR、逐页翻译、Markdown 笔记和多对话 Agent 工作流整合到同一个项目空间中，适合科研阅读、文献整理和个人知识工作流。

当前版本：`v2.1.0`

开发、构建和贡献流程请见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 项目简介

这个应用主要解决三类问题：

- 一边阅读 PDF，一边进行 OCR 与逐页翻译
- 一边记录 Markdown 笔记，一边保留可回跳的论文引用
- 一边和 AI Agent 对话，一边复用当前 PDF、Markdown 和附件内容

应用以 `.pdfwb` 作为项目文件格式，并将翻译缓存和 Agent 缓存独立保存，便于恢复、迁移和管理。

## 核心功能

- 本地 PDF 打开、渲染、缩放和页码跳转
- PDF 打开进度显示
- 文本层提取与 OCR 补充识别
- 基于 OpenAI 兼容接口的逐页翻译
- 翻译请求默认关闭 `enable_thinking`
- Markdown 编辑与实时预览
- GFM、列表、代码块、数学公式渲染
- PDF 引用块插入与回跳
- 多对话 AI Agent
- Agent Markdown 回复渲染
- 文本文件与 PDF 附件支持
- 原生桌面拖拽附件
- 项目文件、翻译缓存、Agent 缓存的持久化管理
- 中文 / English 界面切换

## 界面说明

- 左侧：文件栏
  - 显示项目内 PDF、Markdown 文件
  - 支持挂载外部文件引用
- 中间：PDF 阅读与翻译区域
  - 支持 OCR、翻译、滚动联动、图层开关
- 下方或中部：Markdown 编辑区
  - 支持手动写笔记、插入引用、插入 AI 回复
- 右侧：AI Agent
  - 支持多对话、命令输入、附件管理和 Markdown 回复显示
- 设置页
  - 支持语言切换、LLM 配置、Prompt 配置、缓存管理

## 使用教程

### 1. 打开或创建项目

- 新建项目后，可以向文件栏添加 PDF 或 Markdown 文件
- 也可以直接双击 `.pdfwb` 项目文件启动应用并自动载入项目
- 文件栏中的文件会按项目内文件和外部挂载文件分组显示

### 2. 阅读 PDF

- 打开 PDF 后，可以缩放、翻页和跳转到指定页面
- 如果 PDF 自带文本层，程序会优先提取文本
- 如果当前页没有可用文本层，可以使用 OCR
- 如果关闭 PDF 原始图层，阅读容器会保持白底以保证文本可见性

### 3. 翻译 PDF

- 可以按当前页或指定页码范围触发翻译
- 翻译结果按 PDF 分开缓存
- 切换到另一个 PDF 时，会恢复该 PDF 自己的翻译缓存
- 清理缓存后，界面状态和项目索引也会同步刷新

### 4. 编写 Markdown 笔记

- Markdown 区域支持编辑和预览
- 支持插入：
  - 当前选中文本
  - 最近一次 AI 回复
  - PDF 引用块
- 点击引用块可以跳转回对应 PDF 页面

### 5. 使用 AI Agent

- Agent 支持多对话管理
- 输入框支持多行输入
- `Enter` 发送
- `Shift+Enter` 换行
- 可以附加文本文件和 PDF
- 可以选择是否将当前 PDF 文本和当前 Markdown 一起注入上下文
- 回复内容支持 Markdown 渲染

## 指令集

Agent 输入框支持 `>>` 指令，当前包括：

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
- 帮助文本和大部分命令输出支持双语

## LLM 配置

应用使用 OpenAI 兼容的 `/chat/completions` 接口进行对话和翻译。

设置页中可以配置：

- `Base URL`
- `API Key`
- `Model`
- `Chat system prompt`
- `Translation prompt`
- `Glossary / 术语表`

补充说明：

- Translation prompt 只覆盖翻译的系统提示词
- 页面文本本身仍会随请求一起发送
- 术语表会继续附加到请求上下文
- API Key 不会保存进 `.pdfwb` 项目文件

## 项目文件与缓存

### `.pdfwb` 项目文件

`.pdfwb` 是项目快照文件。当前格式版本为 `v3`。

它主要保存：

- 当前 PDF 路径和名称
- 当前页码
- 视图模式
- Markdown 内容与当前 Markdown 路径
- 文件栏索引
- 当前对话 ID
- cache 索引元数据
- LLM 基础配置

### 缓存目录

项目文件同级会创建两个目录：

- `translation_cache`
- `llm_cache`

缓存策略：

- `translation_cache` 按 PDF 分文件保存翻译结果和状态
- `llm_cache` 保存多对话内容与 Agent 项目状态
- 设置页可以显示 cache 文件列表和大小
- 清理 cache 时会同步清理内存状态并刷新界面

## 适用场景

- 阅读英文论文并翻译重点页面
- 在阅读过程中同步整理中文或英文笔记
- 利用 Agent 总结页面、解释术语、生成草稿
- 保存长期项目，在多个 PDF 之间切换继续工作

## Release

当前 Windows 打包产物位于：

- `src-tauri/target/release/bundle/nsis/PDF Reader Workbench_2.1.0_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/PDF Reader Workbench_2.1.0_x64_en-US.msi`

## 已知事项

- 当前前端 bundle 仍然较大，Vite 会提示 chunk size 警告
- 部分本地模型服务的对话兼容问题可能来自模型自身模板，而不是客户端请求格式
- 已运行实例下再次打开另一个 `.pdfwb` 的转发逻辑仍有优化空间

## License

本项目使用 [MIT License](./LICENSE)。

## Contributing

欢迎提交 issue 和 pull request。贡献、开发和构建说明见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
