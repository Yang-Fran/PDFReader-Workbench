# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

## [2.4.0] - 2026-03-21

### Added

- Native WebView based Markdown PDF export for Windows without bundled Chromium, Pandoc, or Typst
- Shared Markdown normalize / preview / print services for a cleaner export pipeline
- Beginner onboarding message for empty projects and first-run workspace state
- Message actions in Agent chats, including edit, delete, and regenerate flows
- Export diagnostics artifacts and native PDF export session logs for troubleshooting

### Changed

- Rebuilt Markdown preview and PDF print rendering with better formula, HTML, local image, and attachment handling
- Simplified PDF export settings around the single native export path
- Refined desktop UI, including the left status rail, file tree interactions, toast placement, and dark-mode polish
- Updated README, CONTRIBUTING, and pre-input guidance to match the 2.4 architecture

### Fixed

- Manual conversation titles no longer get overwritten by later messages
- Paste, drag-and-drop, and image attachments now behave consistently in the Agent pane
- Notes selection, CodeMirror theming, and modal close behavior in dark mode
- Multiple PDF export issues around page headers, footers, formulas, and print preparation

## [2.3.0] - 2026-03-13

### Added

- Dual PDF export pipelines: `Simple` with Chromium-based paged printing and `Academic` with Pandoc + Typst
- Export executable path pickers in Settings for browser, Pandoc, and Typst
- Bundled tool lookup under the application `tools/` directory for export dependencies
- NSIS installer language selector with English and Simplified Chinese
- NSIS optional bundled-tool install flow for Chromium, Pandoc, and Typst

### Changed

- Reworked Markdown PDF export to use higher-quality rendering and configurable pagination settings
- Moved export configuration into Settings and cleaned the Notes export action flow
- Updated README and project brief for the 2.3 release line

### Fixed

- Export no-op behavior when the previous hard-coded Chromium path did not exist
- Runtime export tool discovery by falling back across bundled tools, user-selected paths, and PATH

## [2.2.0] - 2026-03-13

### Added

- Current-page-only PDF attachment support in the Agent pane
- In-place regenerate action for failed AI replies
- `>>prev` command to repeat the previous action
- Hide-commands toggle for a cleaner Agent reading view
- Rust streaming proxy path for local OpenAI-compatible endpoints

### Changed

- Merged system-side Agent context blocks into a single system message for better local-model compatibility
- Updated README and project brief for the 2.2 release line

### Fixed

- Local endpoint streaming behavior for LM Studio style `localhost` / `127.0.0.1` nodes
- Prompt assembly failures when combining current-page attachments with injected PDF/Markdown context

## [2.1.0] - 2026-03-13

### Added

- Open-source project documentation, license, and contribution guide
- Multi-dialog Agent workflow with Markdown-rendered replies
- File sidebar with project-local and mounted PDF/Markdown grouping
- Per-PDF translation cache storage and project-level LLM cache storage
- Project auto-open support for `.pdfwb` files launched from the OS
- Cache inspection and cleanup controls in settings

### Changed

- Refined README to focus on end-user usage instead of development setup
- Moved development and contribution guidance into `CONTRIBUTING.md`
- Project snapshots now store lightweight metadata while cache payloads live beside the project
- Translation requests force `enable_thinking: false` for faster response

### Fixed

- Translation cache isolation between multiple PDFs in the same project
- Project save/load behavior around cache restoration
- Agent attachment drag-and-drop through native desktop events
- Markdown PDF quote navigation and rendering behavior
