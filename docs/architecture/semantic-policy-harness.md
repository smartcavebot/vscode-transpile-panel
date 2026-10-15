# Live semantic policy and target harness profiles (SMA-240)

The projection core treats policy and target harness state as part of each bounded provider request. The VS Code adapter reads `transpilePanel.policyChoices` and `transpilePanel.harnessFacilities` at pair creation and on configuration changes.

## Policy choices

The first schema is `csharp-python-v1`. Initial choices, with defaults in parentheses:

- `linq`: `lazy` (default), `eager`
- `exceptions`: `throw` (default), `result`
- `async`: `asyncio` (default), `sync`
- `inheritance`: `inherit` (default), `compose`
- `attributes`: `decorators` (default), `registration`

For example, a VS Code settings fragment:

```json
{
  "transpilePanel.policyChoices": {
    "linq": "eager",
    "exceptions": "result"
  },
  "transpilePanel.harnessFacilities": ["decimal"]
}
```

Unknown choices or unsupported values fail closed. The schema is not coupled to VS Code; other hosts can resolve the same policy definition. The current scaffold provider receives these choices but does **not** yet implement policy-specific semantic lowering. Policy-aware provider implementations and evaluation belong to later milestones.

## Harness facilities and provenance

A `HarnessProfile` identifies target-language support facilities separately from source-owned translated fragments. The first available facility is `decimal` for Python, which supplies `from decimal import Decimal`.

The core exposes `HarnessSection` and `TranslatedSection` with explicit origin kinds. The VS Code Python renderer places labeled harness code before the translated source:

```python
# [harness facility: decimal]
from decimal import Decimal

# [translated source]
value = Decimal("1.25")
```

This is not a claim that support code was translated from the source document. Other target languages require their own renderer before harness sections are enabled.

## Live revision semantics

Changing the effective policy/harness profile:

1. Cancels in-flight provider work and advances the session revision.
2. Drops prior source/projection advisory context from the old semantics.
3. Preserves source anchors but marks translated segments stale.
4. Requests whole stale segments through the bounded source-ownership planner (never splitting unknown target correspondence).
5. Fills remaining gaps using the configured line/character caps and publishes accepted results only for the current revision.

If an existing source-owned segment is larger than the new hard cap, the planner fails explicitly rather than silently sending oversized context. This is a documented limitation of a segment-granularity target buffer and motivates future finer-grained correspondence.

Harness-only changes currently also invalidate translated segments conservatively. Semantic dependency tracking may optimize that later.

## Limits

The initial provider is a scaffold, not a complete C#→Python semantic compiler. Policy selections are propagated to providers; they are not falsely represented as implemented transformations. The first harness renderer supports Python comments and Python support facilities only. Neither the host-neutrality invariant nor literal-redaction boundary is relaxed by these profiles.
