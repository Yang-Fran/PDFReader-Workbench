# PDF Reader Workbench

PDF Reader Workbench is a Windows desktop workspace for reading PDFs, running OCR, translating pages, writing Markdown notes, and working with an AI agent in one project file.

Current release: `v2.2.0`

## Overview

The application is built with Tauri 2, React 18, TypeScript, Vite, Zustand, and Tailwind. It is designed for paper reading, course material review, and document-centered AI workflows.

Core capabilities:
- Open local PDF and Markdown files inside one workspace
- Run OCR on pages without a usable text layer
- Translate PDF pages through an OpenAI-compatible API
- Keep Markdown notes and PDF quote blocks linked to source pages
- Use a multi-dialog AI agent with Markdown-rendered replies
- Attach files, attach the current PDF page only, or inject current PDF and Markdown context
- Save and reopen `.pdfwb` projects with external cache directories

## Quick Start

### Install

Use one of the Windows installers from the latest release:
- `PDF Reader Workbench_2.2.0_x64-setup.exe`
- `PDF Reader Workbench_2.2.0_x64_en-US.msi`

### Open a workspace

1. Launch the app.
2. Create a new project or open an existing `.pdfwb` file.
3. Add PDF and Markdown files from the left file sidebar.
4. Configure your API endpoint, API key, and model in Settings.

### Basic workflow

1. Open a PDF and move to the target page.
2. Run OCR or translation on the current page.
3. Insert selected text, PDF quotes, or AI replies into Markdown notes.
4. Ask questions in the Agent pane and keep multiple dialogs per project.
5. Save the project to persist notes and cache indexes.

## Interface

### Left sidebar

- Project-local PDF and Markdown files
- Mounted external files
- Collapsible file tree grouped by file type

### Center workspace

- PDF pane with page jump, OCR, translation, and layer controls
- Markdown editor and preview

### Right sidebar

- Multi-dialog AI agent
- Markdown-rendered answers
- Attachment uploads and current-page attachment
- Command mode with `>>...`

## Agent commands

- `>>help`
- `>>ocr [page]/help`
- `>>tran [page|range]/help/state`
- `>>new proj`
- `>>new dialog [name]`
- `>>new md [name]`
- `>>open`
- `>>file`
- `>>del`
- `>>clear`
- `>>prev`
- `>>refresh pdf|md|agent|cache`
- `>>beginner`
- `>>quit`

Commands are case-insensitive.

## LLM and networking

- Chat and translation use OpenAI-compatible `/chat/completions`
- Translation requests force `enable_thinking: false`
- Remote endpoints use frontend streaming when available
- Local endpoints such as `127.0.0.1` and `localhost` use a Rust streaming proxy for more stable token streaming
- If a request path fails, the app falls back through multiple transport layers

## Project and cache layout

Project files use `.pdfwb`.

The actual cache payloads are stored beside the project file:
- `translation_cache/`
- `llm_cache/`

This keeps the project file lightweight while preserving:
- per-PDF translation cache
- agent dialog cache
- project state cache

## Development

Developer setup, contribution workflow, and project structure are documented in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Changelog

Release notes are tracked in [CHANGELOG.md](./CHANGELOG.md).

## License

This project is licensed under the [MIT License](./LICENSE).
