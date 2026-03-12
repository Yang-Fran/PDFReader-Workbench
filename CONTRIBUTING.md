# Contributing

Thanks for contributing to PDF Reader Workbench.

This project is a desktop workspace for PDF reading, translation, note-taking, and AI-assisted analysis. Contributions are welcome for bug fixes, UX improvements, documentation, tests, performance work, and packaging.

## Scope

Good contribution areas include:

- PDF rendering and navigation
- OCR and translation workflows
- Markdown editing and preview
- Agent commands, dialogs, and attachments
- Project save/load behavior
- Cache consistency and recovery
- Localization
- Packaging and installer behavior
- Documentation and examples

## Development Setup

Prerequisites:

- Node.js 18+
- Rust stable
- Windows desktop environment supported by Tauri 2

Install dependencies:

```powershell
npm install
```

Run in development:

```powershell
npm run tauri:dev
```

Frontend-only development:

```powershell
npm run dev
```

Build:

```powershell
npm run build
```

Package:

```powershell
npm run tauri:build
```

## Project Conventions

- Keep edits focused and small.
- Preserve the existing Tauri + React + Zustand structure.
- Do not store API keys in project files.
- Keep project snapshots lightweight; large payloads belong in cache directories.
- Prefer file-specific cache behavior over global mutable state.
- Preserve bilingual UX where the UI already supports Chinese and English.
- When changing commands, keep help output and localized strings in sync.

## Code Style

- TypeScript first.
- Prefer clear state transitions over implicit side effects.
- Avoid unnecessary dependencies.
- Keep comments short and only where they reduce ambiguity.
- Follow the existing naming and file layout unless there is a strong reason to refactor.

## Testing and Verification

Before opening a pull request, run:

```powershell
npx tsc --noEmit
npm run build
```

If your change affects the Tauri backend, also run:

```powershell
cd src-tauri
cargo check
```

If your change affects packaging, verify:

```powershell
npm run tauri:build
```

## Pull Requests

Please include:

- what changed
- why it changed
- any user-visible behavior differences
- migration or compatibility notes if relevant
- screenshots or short recordings for UI changes when practical

Try to keep one pull request focused on one concern. Large mixed PRs are harder to review and more likely to regress project save/load or cache behavior.

## Issues

When reporting bugs, include:

- app version
- platform
- reproduction steps
- expected behavior
- actual behavior
- project file / cache details if the bug is related to save, load, or restore

For LLM-related issues, include:

- provider type
- base URL format
- model name
- whether the problem is chat, translation, or both

Do not include real API keys in issues or pull requests.

## Documentation Contributions

Documentation improvements are welcome, especially for:

- onboarding
- command reference
- project file format
- cache behavior
- troubleshooting
- packaging and release flow

## AI-Assisted Contributions

AI-assisted development is allowed.

If you use AI substantially in a contribution, disclose it briefly in the pull request description so reviewers know where extra validation may be needed.

This repository may include documentation, implementation, and maintenance work assisted by:

- GPT-5.3-Codex
- GPT-5.4

Human review is still expected for correctness, security, and release readiness.
