# Literal provider boundary

The first production security boundary is intentionally defined for the canonical **C# → Python** projection pair.

## Invariant

Recognized literal payloads are local data. A projection provider receives structural placeholders instead of literal values for:

- current bounded source context,
- the exact source-owned focus,
- prior source focus, and
- prior target projection.

Provider output is restored locally after the call. Placeholder namespaces are selected per request and never reuse a namespace already present in any protected fragment.

The boundary is fail-closed for language pairs it does not implement. Adding another target language requires an explicit literal policy rather than silently bypassing protection.

## Initial deterministic lowering

For C# → Python the boundary currently lowers, without provider participation:

- `true`, `false`, `null` → `True`, `False`, `None`;
- integer/float literals, removing C# numeric type suffixes where Python does not need them;
- `decimal` literals (`m`/`M`) → `Decimal("…")` to preserve decimal semantics rather than silently converting to binary float;
- ordinary and verbatim C# strings/chars → escaped Python strings;
- C# UTF-8 string literals (`"…"u8`) → Python byte strings;
- numeric `new byte[] { … }` initializers → `bytes([…])`;
- ordinary/verbatim interpolated strings by redacting literal segments while leaving interpolation expressions visible to the provider.

The session allows a provider boundary to stabilize source ownership before a request. The literal boundary uses that hook to widen a focus that intersects only part of a recognized literal, so an incremental edit inside a string cannot send a raw substring or create a target segment that owns only part of the literal.

The boundary scans the full source before context is sliced. Consequently, advisory context that begins or ends inside a multiline verbatim literal is masked even when the literal's opening delimiter is outside the context window.

## Deliberate residuals

This is a literal boundary, not a general secret scanner. Identifier names, comments, and non-literal semantic data can still cross a provider boundary and need separate policy if they are considered sensitive.

C# raw string literals are recognized for containment but are not yet semantically lowered. If one intersects provider-owned focus, the request fails closed. Raw strings that appear only in advisory context are masked.

Prior Python f-strings are currently redacted as whole target literals rather than exposing their expression substructure. This is safe but gives a future semantic provider less incremental context than the C# interpolation path.

`Decimal("…")` is semantically intentional but requires the Python decimal facility to be available; target-harness policy should own how that import/support is supplied.
