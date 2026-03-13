# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

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
