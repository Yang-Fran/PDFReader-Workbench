# Contributing

This document is the working guide for contributors to PDF Reader Workbench.

## Goals

The project is built around one workspace that keeps these tasks together:

- read PDFs
- recover text with OCR
- translate pages
- write Markdown notes
- ask questions through the Agent pane
- export notes to PDF

When changing behavior, keep those workflows aligned instead of optimizing one pane in isolation.

## Tech Stack

- Tauri 2
- React 18
- TypeScript
- Vite
- Zustand
- Tailwind

## Local Setup

Install frontend dependencies:

```powershell
npm install
```

Run the desktop app:

```powershell
npm run tauri:dev
```

Optional frontend-only dev server:

```powershell
npm run dev
```

## Validation

Run these before handing off changes:

```powershell
npx tsc --noEmit
```

```powershell
cd src-tauri
cargo check
```

If you touched packaging, export, or desktop-only code, also run:

```powershell
npm run tauri:build
```

## Code Map

- `src/App.tsx`
  - top-level shell and panel layout
- `src/stores/appStore.ts`
  - shared app state, dialogs, project state, caches
- `src/components/pdf/PdfPane.tsx`
  - PDF viewer, OCR, translation view
- `src/components/notes/NotesPane.tsx`
  - Markdown editor, preview, PDF export trigger
- `src/components/agent/AgentPane.tsx`
  - chat, commands, attachments, dialog management
- `src/components/settings/SettingsPanel.tsx`
  - runtime settings and export settings UI
- `src/services/pdfExportService.ts`
  - Markdown normalization, HTML render, MathJax, print HTML builder
- `src/services/beginnerGuide.ts`
  - beginner onboarding text shared by commands and new-project seeding
- `src/services/commandService.ts`
  - `>>` command parsing and command help
- `src/services/projectService.ts`
  - create, open, save project flows
- `src-tauri/src/lib.rs`
  - Tauri commands and backend coordination
- `src-tauri/src/native_pdf_export_windows.rs`
  - WebView2 native PDF export on Windows

## Markdown And Export Architecture

Current path:

1. CodeMirror editing
2. normalization of custom tags and assets
3. `markdown-it` parsing
4. MathJax typesetting
5. print transform and print CSS
6. native WebView PDF export

Contributor rules for this area:

- keep preview and export on the same render pipeline
- do not reintroduce bundled Chromium
- prefer deterministic HTML and CSS over browser-specific hacks
- keep relative and absolute asset paths working
- preserve math support and HTML passthrough
- leave enough temporary artifacts or logging to debug export failures

## UI Rules

- Do not close modal dialogs on accidental drag-selection release outside the dialog body
- Backdrop close should only happen when the user actually clicks the backdrop
- Preserve dark mode behavior when changing progress bars or overlays
- Avoid changing established interaction patterns without checking the adjacent panes

## Documentation Rules

If you change behavior in any of these areas, update docs in the same task:

- onboarding
- `>>beginner`
- README quick start
- export architecture
- contributor notes
- `pre-input.txt`

This prevents context drift between code, docs, and future handoff notes.

## Project And Cache Behavior

- `.pdfwb` stores lightweight project state
- `translation_cache/` stores per-document translation payloads
- `llm_cache/` stores dialog and agent state

Do not silently change cache formats or project shape without updating load/save compatibility.

## Pull Requests

A good PR should include:

- what changed
- why it changed
- user-visible impact
- validation performed
- any remaining risk or follow-up

If the change affects export, mention:

- preview behavior
- print behavior
- native runtime assumptions
- whether relative assets were verified

## Known Sensitive Areas

- `src/components/settings/SettingsPanel.tsx`
  - large file with some historical text-encoding noise
- `src/services/commandService.ts`
  - mixed command help and user-facing guidance
- `src-tauri/src/lib.rs`
  - old export helpers may remain even when the active path changes

Prefer small, deliberate edits in these files and validate immediately after.
