# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-03-13

### Fixed

- Database rows now correctly download their child pages and child databases (recursive descent)
- `downloadDatabase` respects max depth limit, preventing unbounded recursion through nested databases
- Database row IDs tracked in visited set, preventing duplicate downloads and infinite cycles
- All Notion API calls (including nested block fetches by notion-to-md) now route through the rate-limit throttle, preventing 429 errors
- Silent `catch {}` blocks replaced with proper error logging to stats and onError callback
- Top-level page detection now handles Notion's block-parented child pages (parent.type = block_id)
- Top-level page detection now handles inline databases whose IDs don't appear in search results
- Asset download size limit enforced via streaming byte count (no longer bypassed when Content-Length header is missing)

### Changed

- Block-splitting logic extracted into shared `splitBlocksAtBoundaries` function (eliminates code duplication)
- Asset downloads now run with bounded concurrency (5 parallel) instead of sequentially
- Page selection starts with none selected by default instead of all selected
- Notion SDK log level set to ERROR to suppress expected 404 warnings during parent resolution

## [0.1.1] - 2026-03-13

### Fixed

- Config directory renamed from `~/.notion-to-fs` to `~/.pagesdown`
- Updated all internal references to match `pagesdown` package name

## [0.1.0] - 2026-03-13

### Added

- Guided CLI walkthrough for creating a Notion integration and sharing pages
- Download Notion pages and databases to local Markdown files
- Recursive page hierarchy preserved as folder structure
- Database rows exported with YAML frontmatter for properties
- Image and file assets downloaded to local `assets/` folders with relative links
- Child page and database links inline in correct order (block-segment interleaving)
- Database index files for navigable relative links
- OS-aware save location picker (Desktop, Documents, Downloads, OneDrive on Windows)
- Token persistence for returning users (~/.pagesdown/config.json)
- Rate limit handling with automatic retry and promise-chain queue
- Real-time progress reporting (status, milestones, errors)
- Page selection with refresh loop for sharing additional pages
- Cross-platform filename sanitization (Windows reserved names, invalid chars, path traversal)
- SSRF protection blocking private/internal IP ranges in asset downloads
- Fetch timeout (60s) for asset downloads
- YAML injection protection in database frontmatter
- Cycle detection and max depth limit (20) for recursive page traversal
- ANSI Shadow ASCII art banner
- MIT license

[Unreleased]: https://github.com/neethanwu/pagesdown/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/neethanwu/pagesdown/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/neethanwu/pagesdown/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/neethanwu/pagesdown/releases/tag/v0.1.0
