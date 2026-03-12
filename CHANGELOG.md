# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

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
