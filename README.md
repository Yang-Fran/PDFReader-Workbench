# PDF Reader Workbench

PDF Reader Workbench is a Windows desktop workspace for reading PDFs, running OCR, translating pages, writing Markdown notes, and working with an AI agent inside one project.

## What It Does

- Open local PDF and Markdown files inside one workspace
- Run OCR on pages without a usable text layer
- Translate PDF pages through an OpenAI-compatible chat API
- Keep Markdown notes, PDF quotes, and AI replies together
- Render Markdown with HTML blocks, math, images, links, and attachments
- Export Markdown notes to PDF through the system WebView pipeline
- Save and reopen `.pdfwb` projects with external cache folders
- Share one global settings file across different projects on the same machine

## Current Stack

- Tauri 2
- React 18
- TypeScript
- Vite
- Zustand
- Tailwind

## Markdown And PDF Export

The current Markdown path is:

1. CodeMirror for editing
2. A normalization layer for custom tags and asset resolution
3. React Markdown / `markdown-it`-based rendering helpers
4. KaTeX for math rendering
5. Paged.js-assisted print preparation plus print CSS
6. Tauri native export through the system WebView

Important notes:

- The app does not depend on bundled Chromium for PDF export
- Windows export uses the installed WebView2 runtime
- Export prefers WebView2 DevTools `Page.printToPDF` to generate tagged PDFs and built-in outline/bookmarks, then falls back to `PrintToPdf` when needed
- Relative and absolute asset paths are normalized before preview and export
- Markdown preview and PDF export share the same asset-resolution rules
- Relative Markdown assets are resolved from the current notes file path, or from the project path when no notes file exists yet

## Settings And Project Data

- App-level settings are stored in the app config directory as `settings.json`
- Projects store workspace state, notes path, cache indexes, and view state
- Translation cache lives in `translation_cache/`
- Agent cache lives in `llm_cache/`
- This keeps the project file lightweight while allowing multiple projects to share one settings profile

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
- Markdown preview: `src/components/markdown/MarkdownPreview.tsx`
- Settings: `src/components/settings/SettingsPanel.tsx`
- App settings service: `src/services/appSettingsService.ts`
- Markdown print/export service: `src/services/markdownPrintService.ts`
- Beginner guide text: `src/services/beginnerGuide.ts`
- Tauri backend: `src-tauri/src/lib.rs`
- Windows native PDF export: `src-tauri/src/native_pdf_export_windows.rs`

## More Docs

- Contributor workflow: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Recent changes: [CHANGELOG.md](./CHANGELOG.md)

## License

This project is licensed under the [MIT License](./LICENSE).
