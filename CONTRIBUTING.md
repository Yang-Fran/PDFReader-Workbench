# 贡献指南

感谢你为 PDF Reader Workbench 做贡献。

这个项目是一个面向 PDF 阅读、OCR、翻译、Markdown 笔记与 AI 辅助分析的桌面工作台。为了让协作更高效、提交更稳定，建议在开始开发前先阅读本文件。

## 适合贡献的方向

欢迎以下类型的改进：

- PDF 渲染、跳转、缩放与阅读体验
- OCR 与翻译流程
- Markdown 编辑、预览与引用机制
- Agent 对话、命令、附件与上下文管理
- 项目保存、加载、恢复与缓存一致性
- 多语言界面与文案
- 性能优化与打包流程
- 测试、文档与示例补充

## 开发环境

建议环境：

- Node.js 18 及以上
- Rust stable
- Windows 桌面环境
- Tauri 2 对应的本地构建依赖

安装依赖：

```powershell
npm install
```

启动开发环境：

```powershell
npm run tauri:dev
```

如果只调试前端：

```powershell
npm run dev
```

构建前端：

```powershell
npm run build
```

打包桌面应用：

```powershell
npm run tauri:build
```

## 项目结构速览

主要目录如下：

```text
src/
  components/
  services/
  stores/
src-tauri/
README.md
CONTRIBUTING.md
```

重点文件与职责：

- `src/App.tsx`
  - 应用主框架与整体布局
- `src/stores/appStore.ts`
  - 全局状态、项目状态、对话状态、缓存状态
- `src/components/pdf/PdfPane.tsx`
  - PDF 阅读、页码切换、翻译联动、OCR 入口
- `src/components/notes/NotesPane.tsx`
  - Markdown 编辑与预览
- `src/components/agent/AgentPane.tsx`
  - Agent 对话、多会话、附件、命令输入
- `src/components/files/FileSidebar.tsx`
  - 文件树、项目文件、挂载文件
- `src/components/settings/SettingsPanel.tsx`
  - 设置、语言、Prompt、缓存管理
- `src/services/llmService.ts`
  - LLM 请求拼装与调用
- `src/services/projectService.ts`
  - `.pdfwb` 项目文件保存与读取
- `src/services/workspaceService.ts`
  - `translation_cache` / `llm_cache` 管理
- `src-tauri/src/lib.rs`
  - Tauri 后端命令、本地文件能力、启动参数处理

## 开发约定

请尽量遵守以下约定：

- 保持改动聚焦，不要在一个提交里混入多个无关主题
- 尽量延续现有的 `Tauri + React + Zustand` 结构
- 不要把 API Key、个人账号信息、临时工作文件写入仓库
- 项目快照应保持轻量，较大的运行态内容应放入 cache
- 涉及多 PDF、对话、缓存时，优先考虑“按文件隔离”而不是全局共享状态
- 改动指令集时，要同步维护帮助输出和本地化文本
- 改动 UI 文案时，要注意中英文兼容

## 代码风格建议

- 优先写清晰可维护的 TypeScript，而不是过度压缩的技巧性代码
- 状态切换应尽量显式，避免隐式副作用堆叠
- 不要无意义引入新依赖
- 注释保持简短，只在确实能减少理解成本时添加
- 若没有充分理由，不要随意改动现有模块边界和文件布局

## 提交流程建议

建议按以下方式推进：

1. 先明确问题范围，只处理一个主题
2. 在本地完成实现和最小验证
3. 自查是否影响：
   - 项目保存 / 加载
   - 多 PDF 翻译缓存
   - Agent 多对话
   - Markdown 引用回跳
   - 中英文文案
4. 提交前补必要文档说明

推荐的提交类型示例：

- `feat: add ...`
- `fix: resolve ...`
- `refactor: simplify ...`
- `docs: update ...`

如果仓库仍沿用现有简短风格提交信息，也至少要确保提交信息能准确描述改动目标。

## 提交前验证

提交 Pull Request 前，至少运行：

```powershell
npx tsc --noEmit
npm run build
```

如果改动涉及 Tauri 后端，再运行：

```powershell
cd src-tauri
cargo check
```

如果改动涉及打包、安装器或 release 流程，再额外运行：

```powershell
npm run tauri:build
```

## UI 改动要求

如果改动影响界面，请尽量提供：

- 修改前后的行为说明
- 截图或短录屏
- 深色 / 浅色模式是否都测试过
- 中英文界面是否都检查过

尤其是以下区域，容易产生联动问题：

- PDF 与翻译区同步
- 文件栏切换与项目文件索引
- Markdown 引用块渲染与回跳
- Agent 多对话与附件区
- 设置页缓存清理后的状态刷新

## Issue 与 PR 建议

提 issue 时，建议写清楚：

- 应用版本
- 平台信息
- 复现步骤
- 预期行为
- 实际行为
- 如果和项目保存或缓存有关，补充相关文件和 cache 情况

提 Pull Request 时，建议写清楚：

- 改了什么
- 为什么要改
- 用户可见行为有什么变化
- 是否有兼容性影响
- 是否需要迁移旧项目或旧缓存

## 文档贡献

文档改进同样非常有价值，尤其包括：

- 新手上手说明
- 指令集说明
- 项目文件格式说明
- cache 行为说明
- 常见问题排查
- 打包与 release 流程

## AI 辅助开发说明

允许使用 AI 辅助开发，但默认要求人工复核。

如果某个 PR 大量依赖 AI，请在 PR 描述里简单说明，方便 reviewers 提高验证强度。

本仓库的文档、实现或维护过程中，可能会使用以下模型辅助：

- GPT-5.3-Codex
- GPT-5.4

AI 生成内容不应替代人工对正确性、安全性、兼容性和可维护性的审查。
