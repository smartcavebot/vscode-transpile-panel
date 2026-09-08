# VS Code Transpile Panel

A native side-by-side VS Code projection surface for incrementally mapping source code into another programming language.

The current repository contains the projection runtime and editor integration. **Semantic transpilation is not implemented yet**: the active `ScaffoldProjectionProvider` deliberately echoes each exact source focus unchanged and marks the result uncertain. Its purpose is to exercise source ownership, bounded provider context, cancellation, rebasing, and target-buffer invariants before a real C#→Python provider is introduced.

## Current behavior

- Opens a readonly native VS Code virtual document beside the source editor.
- Supports pinned and follow-active source/target pairing.
- Invalidates and rebases target ownership immediately when the source changes.
- Runs provider refresh manually or after a configurable debounce.
- Separates provider **context** from exact source **focus** whose returned text may own target output.
- Completes initial coverage through sequential line- and character-bounded focus requests; minified one-line files cannot silently become whole-file provider requests.
- Cancels stale work and rejects stale provider results.
- Keeps the projection core host-neutral; VS Code types remain in the adapter layer.

## Commands

- `Transpile Panel: Open Projection`
- `Transpile Panel: Refresh Projection`

## Configuration

| Setting | Default | Purpose |
| --- | ---: | --- |
| `transpilePanel.targetLanguage` | `python` | VS Code language id for the target document. |
| `transpilePanel.pairingMode` | `pinned` | Keep the current source or follow the active editor. |
| `transpilePanel.refreshMode` | `debounced` | Manual or debounced provider refresh after edits. |
| `transpilePanel.debounceMs` | `750` | Debounce delay in milliseconds. |
| `transpilePanel.contextLines` | `12` | Surrounding line radius available as provider context. |
| `transpilePanel.maxContextCharacters` | `12000` | Hard provider-context character cap. |
| `transpilePanel.coverageChunkLines` | `80` | Maximum lines owned by one initial-coverage focus. |
| `transpilePanel.coverageChunkCharacters` | `6000` | Hard character cap for one initial-coverage focus. |

## Development

```sh
npm ci
npm run check-types
npm run check:host-neutral
npm run test:core
npm run compile
```

The CI gate runs dependency installation, strict TypeScript checking, the host-neutrality guard, and the headless core smoke suite.

## Architecture

The central rule is that provider context is not target ownership. `sourceRegion`/`sourceRange` are bounded advisory context; `focusRegion`/`focusRange` are the exact source span whose provider result may own target text. This distinction prevents overlapping context windows from absorbing unrelated target segments.

See `docs/architecture/host-boundary.md` and `docs/architecture/host-coupling-debt.md` for the current host-boundary design.

## Provenance and license

This repository began as a derivative of `iyulab/vscode-translate-panel` and retains upstream MIT attribution. The old natural-language translation webview, comment parsers, Google/Gemini providers, and related runtime dependencies have been removed from the active codebase.

See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
