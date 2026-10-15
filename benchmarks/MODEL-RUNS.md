# Model comparison runs — SMA-246

The corpus is now 16 C#→Python trajectories (41 sequential edit events) covering nullability, pattern matching, records, generics, async, disposal, delegates, attributes, exception rethrow, interpolation/privacy, lazy/eager LINQ, casts, incomplete editor states and simultaneous edits. Fixtures are small **hypothesis/test cases**; a reference target can be policy-dependent and is not a proof of semantic equivalence.

## Execute genuine model attempts (local by default)

Run an OpenAI-compatible inference server explicitly (for example Ollama's compatibility endpoint, vLLM or llama.cpp). Load the model separately; no models are downloaded automatically. Node.js 20+ and `npm ci` are needed. Example POSIX shell (replace the model id with the **actual id** exposed by your chosen server):

```sh
npm ci
export PROJECTION_BENCH_ENDPOINT=http://127.0.0.1:11434/v1/chat/completions
export PROJECTION_BENCH_MODEL=YOUR_LOADED_MODEL_ID
export PROJECTION_BENCH_QUANTIZATION=Q4
export PROJECTION_BENCH_OUTPUT=benchmarks/attempts.local-q4.recorded.json
node benchmarks/record-model.js
node benchmarks/run.js benchmarks/attempts.local-q4.recorded.json > benchmarks/results.local-q4.json
```

Windows PowerShell can set the same environment variables via `$env:PROJECTION_BENCH_MODEL = "..." `. To start with one sequence, set `PROJECTION_BENCH_CASE=linq-eager-001`. Select protocols with a comma-separated `PROJECTION_BENCH_PROTOCOLS` value, e.g. `full-rewrite,update-instruction,grounded-micro-edit`.

The recorder uses the same trajectory and grounded-patch contract as the evaluator, sequentially updates previous target state, measures monotonic wall-clock request time, records actual outbound JSON character count and reported prompt tokens when available. It records transport/format failures as errors, not invented patches. Actual response text, model id, quantization and timing are written to JSON. Outputs are ignored by git by default; inspect and explicitly authorize any publication.

## Security and limits

Endpoints default to **loopback only**. Remote calls require `PROJECTION_BENCH_ALLOW_REMOTE=1` and HTTPS, with redirects rejected; API keys come from `PROJECTION_BENCH_API_KEY`, not URLs or recorded outputs. Each trajectory's declared synthetic privacy canaries are replaced with placeholders **before** outbound requests and restored after response parsing. Arbitrary secrets are *not* automatically detected: use only reviewed/public synthetic examples, and do not supply private source code to a hosted oracle.

The whole outbound request has a character cap (default 12000), set by `PROJECTION_BENCH_MAX_CHARACTERS`. This recorder is an initial protocol baseline with a small edit-trajectory corpus; model-specific constrained decoding, structured FIM completions and precise token-budget controls require follow-up adapters. Its prompt is not yet equivalent to the product's full localized secret-protected provider pipeline.

## Pending comparison matrix

All entries below are **planned, not executed**. Model ids must be supplied by the actual inference server; do not infer performance from model size or generic programming scores.

| Family | Size | Role | Quantizations |
| --- | --- | --- | --- |
| Qwen2.5-Coder | 1.5B | small local candidate | Q4 / Q5 / Q8 (available equivalents) |
| Qwen2.5-Coder | 3B | intermediate local candidate | Q4 / Q5 / Q8 |
| Qwen2.5-Coder | 7B | larger local candidate | Q4 / Q5 / Q8 |
| CodeGemma or StarCoder2 | available size | FIM-oriented control | comparable settings |
| CodeT5-class | practical small variant | specialist baseline | feasible quantizations |
| hosted reference model | selected separately | quality ceiling/escalation, with deliberate privacy opt-in | provider-specific |

Compare on identical trajectory sequences, semantic policy, response-format protocol, model/runtime version, sampling parameters, hardware, quantization, and input/output limits. Record real runs for each cell separately and preserve failed attempts. P50/P95 metrics require actual measurements; policy adherence and execution equivalence require validators and independent test oracles before selecting a production model. The synthetic HTTP server in CI validates the **recorder plumbing**, not model intelligence.

## Residual benchmark work

Add model-specific adapters as necessary, track inference server/runtime/build and device provenance in a run manifest, implement sandboxed semantic equivalence and policy adherence checks, measure continuation stability and target churn across the entire corpus, and inspect literal/comment leakage at the provider boundary. Compare full rewrite vs ordinary update vs grounded micro-edits on the *same* models and configurations. No MVP winner is selected from fixture success.
