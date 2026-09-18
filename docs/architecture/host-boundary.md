# Host boundary

## Principle

VS Code is the first delivery host, not the product boundary.

The reusable product is the projection core. Host integrations adapt editor/runtime facilities into host-neutral inputs and render host-neutral outputs.

## Core owns

- normalized document snapshots, positions, ranges, and changes
- projection-session revision and latest-wins semantics
- bounded context selection
- source↔target correspondence state
- deterministic/local lowering and outbound redaction
- semantic policy state
- target harness state
- provider request/response contracts
- grounded patch validation/application semantics
- validation and telemetry interfaces

## Host adapters own

- document/editor lifecycle
- editor change events
- commands and keybindings
- presentation, layout, syntax-highlighting integration, and focus
- configuration UX
- secret-storage implementation
- workspace/filesystem/process integration that is host-specific

## Hard invariants

1. `src/core/**` must not import `vscode`.
2. Core public APIs must not expose VS Code-native types such as `TextDocument`, `Range`, `Uri`, `ExtensionContext`, or `SecretStorage`.
3. A host adapter normalizes host-native changes before they enter the core.
4. Provider implementations receive bounded host-neutral requests; providers do not silently widen a request to an entire file.
5. Source mutation invalidates older projection work immediately. Stale provider results never become visible state.
6. VS Code-specific convenience is encouraged inside the adapter layer; portability does not justify reimplementing editor features in the core.
7. Core telemetry contracts are content-free by default. Raw source, target, prompt, literal, or provider-response capture requires a separate explicit opt-in design.

## Initial package seam

`src/core/` is the host-neutral package boundary. It now defines:

- normalized text/document values
- semantic policy and harness values
- provider/cancellation contracts
- bounded, revision-safe projection sessions
- source-owned target projection segments
- local literal lowering and outbound redaction
- exact grounded SEARCH/REPLACE patch validation/application
- target validation contracts and deterministic validator coordination
- metadata-only telemetry contracts

`src/adapters/vscode/` is the first concrete host adapter. The current boundary crossings are explicit conversions rather than shared host-native types:

| VS Code side | Boundary function | Core side |
| --- | --- | --- |
| `vscode.Position` | `toCorePosition` | `TextPosition` |
| `vscode.Range` | `toCoreRange` | `TextRange` |
| `vscode.TextDocument` | `toCoreDocument` | `DocumentSnapshot` |
| `vscode.TextDocumentContentChangeEvent` | `toCoreChange` | `TextChange` |
| `vscode.TextDocumentChangeEvent` | `toCoreChanges` | `readonly TextChange[]` |
| `TextPosition` | `toVscodePosition` | `vscode.Position` |
| `TextRange` | `toVscodeRange` | `vscode.Range` |

The direction of dependency is deliberate: the VS Code adapter imports the core; the core never imports the adapter or VS Code.

The legacy script-webview/provider fork path has been removed. The live extension activation path now runs through the host adapter and host-neutral projection core.

## Grounded patch contract

`applyGroundedPatch` uses revision-checked, exact SEARCH/REPLACE edits:

- every SEARCH anchor must be non-empty;
- every anchor must match exactly once in the current target text;
- overlapping duplicate matches count as ambiguous;
- edits apply sequentially, so later anchors are grounded against the text produced by earlier edits;
- stale revisions, missing anchors, and ambiguous anchors fail closed;
- no regex, fuzzy matching, or hidden regeneration occurs in the application layer.

This is the deterministic patch-application baseline. Provider strategy may evolve independently, but accepted patches still pass through this core contract.

## Validation contract

`ProjectionValidator` is host-neutral. A validator receives target text plus revision/policy/harness state and a core cancellation signal. Runtime/process discovery remains outside the core. `runProjectionValidators` preserves validator order, validates returned target ranges, and stops cleanly on cancellation.

## Telemetry contract

`ProjectionTelemetrySink` accepts metadata-only provider/patch/validation events. The contract records identifiers, counts, durations, statuses, and revisions; it does not require raw source/target text or provider payloads. Opt-in corpus capture and persistence remain separate work.

## Executable portability checks

The repository enforces the seam rather than relying on convention alone:

- `npm run check:host-neutral` fails if `src/core/**` imports `vscode`.
- `npm run test:core` compiles only `src/core/**` and exercises it from plain Node, without the VS Code runtime.
- headless smoke suites verify bounded context, latest-wins stale-result rejection, target ownership/rebasing, literal redaction, grounded patch failure modes, validation coordination, and content-free telemetry plumbing.
- CI runs strict TypeScript checking, the host-neutrality guard, and the complete headless core suite on every pull request.

## Migration direction

```text
VS Code TextDocument / events
          |
          v
   VS Code adapter
          |
          v
normalized DocumentSnapshot/TextChange
          |
          v
    projection core
   /       |        \
local   provider   validation
lowering  boundary
          |
          v
host-neutral projection result/patch
          |
          v
   VS Code adapter
          |
          v
native readonly target document
```

The second-host milestone will exercise this same core from a non-VS-Code harness. That is the portability proof; feature parity is not required.
