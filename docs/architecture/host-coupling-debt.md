# Host-coupling debt ledger

This ledger records dependencies that would prevent the projection engine from running in an arbitrary host. VS Code-specific code is expected in the VS Code adapter; the concern is accidental leakage into reusable core behavior.

## Classification

- **adapter-only** — intentionally host-specific; no portability debt if contained.
- **temporary core leak** — host dependency currently owns logic that belongs in the core; must be extracted.
- **fundamental host assumption** — behavior is modeled in a way that may not generalize; requires an architectural decision before expansion.

## Current ledger

| Area | API/dependency | Owner today | Classification | Portability impact | Extraction/removal path | Trigger |
| --- | --- | --- | --- | --- | --- | --- |
| Extension lifecycle | `vscode.ExtensionContext`, commands, workspace/window events | `src/extension.ts` | adapter-only | None if kept outside core | Move orchestration behind a VS Code adapter that normalizes documents/events | C#→Python MVP adapter work |
| Translation service configuration | `vscode.workspace.getConfiguration` | `src/services/TranslationService.ts` | temporary core leak | Provider selection/config cannot run outside VS Code | Replace service with host-neutral projection/provider contracts; inject config from adapter | SMA-243 / SMA-241 |
| Credential storage | ordinary VS Code settings (`geminiApiKey`) | legacy translation service/package config | temporary core leak + security debt | Credentials tied to VS Code and stored in inappropriate surface | Introduce host-neutral secret/config abstraction; VS Code implementation uses `SecretStorage` | provider implementation |
| Target presentation | script-enabled webview | `src/webview/**` | adapter-only legacy debt | Presentation cannot transfer to another host; security surface is larger than needed | Replace with native readonly VS Code virtual document; other hosts provide their own renderer | SMA-237 |
| Scroll synchronization | VS Code visible-range events + webview percentage sync | `src/extension.ts`, `src/webview/**` | adapter-only | No core impact | Keep only if useful in VS Code adapter; do not model as core projection behavior | SMA-237 |
| Natural-language/comment pipeline | parser/comment extraction + translation service | `src/parsers/**`, `src/services/**` | fundamental product mismatch, not portability requirement | Legacy behavior obscures the actual semantic-projection boundary | Retire from primary path as projection core replaces translation pipeline | C#→Python MVP |
| Provider contract | legacy `translate(text,targetLang)` | `src/providers/**` | temporary core leak/product mismatch | Cannot express prior projection, policy, harness, revision, bounded region, or cancellation | Migrate providers to `src/core/provider.ts` contract through adapters while legacy path still exists | SMA-241 |
| Core data model | VS Code `Range`, `TextDocument`, `Uri` if introduced | prohibited in `src/core/**` | guardrail | Would make every alternate host emulate VS Code | Keep normalized values in `src/core/model.ts`; adapters perform conversion | continuous review |

## Review rule

Any new dependency introduced under `src/core/**` must be reviewed for host coupling. A VS Code import in `src/core/**` is a defect, not an accepted convenience.

At each project milestone, review this table and either:

1. close entries whose extraction is complete,
2. add newly discovered coupling,
3. assign an explicit removal condition to any temporary core leak, or
4. record an architectural decision for any fundamental host assumption that is intentionally retained.

Before the second-host portability proof, every blocker must be either removed or explicitly accepted with rationale.
