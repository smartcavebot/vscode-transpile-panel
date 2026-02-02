# Changelog

All notable changes to this project will be documented in this file.

## [1.0.4] - 2025-02-02

### Fixed
- Extension activation failure on VS Code 1.96+ and Insider builds
- Switched to esbuild bundling for reliable dependency resolution

## [1.0.3] - 2025-01-15

### Fixed
- Enhanced table structure protection in Markdown processor

## [1.0.2] - 2024-12-22

### Added
- Enhanced markdown rendering with syntax highlighting (highlight.js + marked)
- Intelligent code block comment extraction - translates only comments, preserves code
- Copy translated markdown button
- Scroll synchronization between editor and preview panel
- Table structure protection during translation

### Fixed
- Placeholder translation issue (English words like "CODE" being translated)
- Windows line ending (CRLF) handling in code block detection
- Table newline preservation during translation

## [1.0.1] - 2024-12-22

### Fixed
- Fix extension activation issue (command not found)
- Fix missing dependencies in packaged extension

## [1.0.0] - 2024-12-22

### Added
- Initial release
- Side-by-side translation preview panel
- Google Translate (unofficial) engine
- Gemini API engine support
- Smart comment extraction for 20+ programming languages
- Markdown support with code block protection
- JSON support with key/structure preservation
- HTML support with tag/script protection
- Real-time sync with debounce (onType mode)
- Save-triggered updates (onSave mode)
- System language detection for default target
- Configurable debounce delay
