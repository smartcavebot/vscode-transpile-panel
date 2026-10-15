# SMA-246 incremental projection benchmark

This benchmark measures trajectories of **edits to unfinished source code**, rather than independent finished snippets. First corpus pair: C# → Python. Schemas permit later Rust/Lua target stress cases.

## Run

```sh
npm ci
node benchmarks/run.js
node benchmarks/test-run.js
node benchmarks/run.js path/to/recorded-attempts.json > results.json
```

The default `attempts.fixture.json` contains deliberately **synthetic** responses. It verifies the scoring pipeline only; no model was evaluated and the figures are not model performance evidence.

`trajectory.schema.json` defines initial source/target and an ordered sequence of old-coordinate source edits, each with an expected new source state and optional reference targets. Syntactically incomplete steps may lack reference targets. `attempt.schema.json` describes recorded provider attempts keyed by trajectory, step, model, optional quantization, and protocol.

Protocols: `full-rewrite`, `update-instruction`, and `grounded-micro-edit`. The latter uses the actual host-neutral `applyGroundedPatch` exact SEARCH/REPLACE implementation with revision checks. An accepted attempt updates the preceding target state; a rejected/missing attempt leaves the preceding target unchanged.

The result JSON separates patch success, exact-reference agreement, Python `ast.parse` success (when Python is installed), measured contiguous diff churn, supplied timing/context figures, and null (UNKNOWN) fields for semantic equivalence, policy adherence, and privacy canaries without external evidence. String agreement is **not** semantic equivalence. P50/P95 only appear when actual timing data was supplied.

The benchmark intentionally does not execute untrusted translated Python. Semantic/execution comparisons require sandboxed reference tests, policy-aware validators, and execution guards. Avoid submitting raw source, prompts, secrets or literal payloads to hosted providers.

## Residual acceptance work

Extend the trajectory corpus across expressions, nullability, LINQ, classes, properties, generics, async, disposal, delegates, decorators, exception flow, interpolation and privacy; integrate representative model adapters and execute Qwen2.5-Coder 1.5B/3B/7B, a FIM control, a small specialist baseline when practical, a hosted oracle, and Q4/Q5/Q8 quantized runs. Record real device/configuration, elapsed time, output patch and outbound context/token measurements. Only then can an MVP model choice be justified. Synthetic smoke results must never enter that comparison as model data.
