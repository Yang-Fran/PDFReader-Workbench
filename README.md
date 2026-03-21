# PDF Reader Workbench

PDF Reader Workbench is a Windows desktop workspace for reading PDFs, running OCR, translating pages, writing Markdown notes, and working with an AI agent in one project.

## What It Does

- Open local PDF and Markdown files inside one workspace
- Run OCR on pages without a usable text layer
- Translate PDF pages through an OpenAI-compatible API
- Keep Markdown notes, PDF quotes, and AI replies together
- Render Markdown with HTML blocks, math, custom links, images, and attachments
- Export Markdown notes to PDF through the system WebView print pipeline
- Save and reopen `.pdfwb` projects with external cache directories

## Current Stack

- Tauri 2
- React 18
- TypeScript
- Vite
- Zustand
- Tailwind

## Markdown And PDF Export

The current Markdown to PDF path is:

1. CodeMirror for editing
2. A normalization layer for custom tags and asset resolution
3. `markdown-it` for Markdown to HTML
4. MathJax for formula layout
5. A print transform plus print CSS for stable pagination
6. Tauri native export through the system WebView

Important notes:

- The app no longer depends on bundled Chromium for PDF export
- Windows export uses the installed WebView2 runtime
- Relative and absolute asset paths are normalized before preview and export
- Markdown preview and PDF export share the same rendering pipeline

## Quick Start

1. Launch the app.
2. Click `New project`.
3. Open `Settings` and fill in `Base URL`, `API Key`, and `Model`.
4. Click `Save project` to create a `.pdfwb` file.
5. Add PDF and Markdown files from the Files sidebar.
6. Open a PDF, run OCR or translation if needed, and write notes in Markdown.

When a new project is created, the first dialog is seeded with the same guide shown by `>>beginner`.

## Agent Commands

- `>>help`
- `>>ocr [page]/help`
- `>>tran [page|range] [stream|expli] [force]/help/state`
- `>>new proj`
- `>>new dialog [name]`
- `>>new md [name]`
- `>>open`
- `>>del`
- `>>clear`
- `>>prev`
- `>>refresh pdf|md|agent|cache`
- `>>beginner`
- `>>quit`

Commands are case-insensitive.

## Project Layout

- Project file: `.pdfwb`
- Translation cache: `translation_cache/`
- Agent cache: `llm_cache/`

This keeps the project file lightweight while preserving notes, translation cache, agent dialogs, and workspace state.

## Development

Install dependencies:

```powershell
npm install
```

Run the desktop app in development:

```powershell
npm run tauri:dev
```

Run frontend type-check:

```powershell
npx tsc --noEmit
```

Run backend validation:

```powershell
cd src-tauri
cargo check
```

## Key Files

- App shell: `src/App.tsx`
- Store: `src/stores/appStore.ts`
- Agent pane: `src/components/agent/AgentPane.tsx`
- Notes pane: `src/components/notes/NotesPane.tsx`
- Settings: `src/components/settings/SettingsPanel.tsx`
- Markdown export service: `src/services/pdfExportService.ts`
- Beginner guide text: `src/services/beginnerGuide.ts`
- Tauri backend: `src-tauri/src/lib.rs`
- Windows native PDF export: `src-tauri/src/native_pdf_export_windows.rs`

## More Docs

- Contributor workflow: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Recent changes: [CHANGELOG.md](./CHANGELOG.md)

## License

This project is licensed under the [MIT License](./LICENSE).
