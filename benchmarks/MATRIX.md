# Reproducible model × quantization × protocol matrix

This is the experiment plan for SMA-246. **Nothing in the matrix is a model performance result.** It deliberately separates prepared inference configurations, unsupported adapter types, and unapproved hosted reference runs.

## Dimensions

The committed `model-matrix.json` defines:
- Qwen2.5-Coder Instruct candidates: 1.5B, 3B, 7B × Q4, Q5, Q8 = **9 intended local model/quantization cells**. These are experiment names, not discovered model artifacts.
- Each configured candidate × **three update protocols**: full rewrite, update instruction, grounded micro-edit = **27 runnable protocol cells per case** when all aliases have been bound.
- An explicitly deferred StarCoder2 FIM control and CodeT5-class specialist, each awaiting the appropriate adapter rather than being misrepresented as a chat model.
- A hosted oracle for later comparison, disabled pending separate approval and privacy assessment.

The full corpus currently contains 16 trajectories / 41 sequential edit events. The pilot selects `linq-eager-001` (one edit), and the privacy gate selects `interpolation-privacy-001` (three edits). Full execution requires an explicit case ID and can be resumed per case, model and protocol.

## Plan only (no inference)

```sh
npm ci
node benchmarks/matrix.js plan --phase pilot
node benchmarks/matrix.js plan --phase privacy
node benchmarks/matrix.js plan --phase full --case async-tasks-001
```

`plan` reports candidate, unavailable-adapter, and approval-required cells; it does not connect to any inference endpoint. No model aliases or quantizations are guessed from experiment labels.

## Bind the actual models

Copy `benchmarks/model-bindings.example.json` to ignored `benchmarks/model-bindings.local.json`, then replace placeholders with your **actually loaded server model alias**, its verified quantization, and runtime version. The quantization string is an operator declaration; the runner checks that it matches the experiment, but cannot inspect a model file's internals. Recording an artifact digest is recommended.

```json
{
  "endpoint": "http://127.0.0.1:11434/v1/chat/completions",
  "deviceLabel": "gpu-runner-01",
  "models": {
    "qwen25coder-1_5b-q4": {
      "modelId": "YOUR_LOADED_MODEL_ALIAS",
      "quantization": "Q4",
      "engine": "YOUR_INFERENCE_ENGINE",
      "runtimeVersion": "YOUR_ENGINE_VERSION",
      "artifactSha256": null
    }
  }
}
```

Bindings and run traces are gitignored. The current recorder requires a chat-completions compatible endpoint and defaults to local loopback; remote inference requires explicit `PROJECTION_BENCH_ALLOW_REMOTE=1` and HTTPS. Do not submit actual confidential source, prompts or arbitrary literals to remote endpoints; fixture canaries are not comprehensive secret detection.

## Run bounded cells

```sh
# One request: start with this before spending time on a full sweep
node benchmarks/matrix.js run --phase pilot --cell qwen25coder-1_5b-q4 --protocol grounded-micro-edit --bindings benchmarks/model-bindings.local.json

# Synthetic privacy-canary gate (3 sequential model requests)
node benchmarks/matrix.js run --phase privacy --cell qwen25coder-1_5b-q4 --protocol grounded-micro-edit --bindings benchmarks/model-bindings.local.json

# One trajectory of the full corpus; explicitly permit up to 3 requests
node benchmarks/matrix.js run --phase full --case async-tasks-001 --cell qwen25coder-1_5b-q4 --protocol grounded-micro-edit --max-requests 3 --bindings benchmarks/model-bindings.local.json
```

The runner **never launches the whole matrix implicitly**. Exactly one model/quantization, protocol and case are executed per command. `--max-requests` defaults to 3; increasing the budget is explicit. Results live under ignored `benchmarks/matrix-runs/<phase>/<case>/<cell>/<protocol>/`, with attempts, scores, an intent fingerprint, and a final manifest with SHA-256 digests. Rerunning a completed cell validates the digests and skips inference. A complete interrupted recording can be reused only when its configuration fingerprint still matches. Failed or mismatched artifacts are not silently overwritten.

The matrix runner uses the existing `record-model.js` inference transport and `run.js` scorer. Current exact-string agreement and syntax checks are **not** semantic-equivalence proof; interpretation, policy adherence and hidden-secrets leakage need independent validation.

## Comparison gates

1. Pilot: test response-format compliance, patch applicability, request/latency budget, and basic edit locality with one source edit per cell.
2. Privacy: run the synthetic interpolation canary sequence and verify the boundary rather than just trusting the model's output.
3. Full: after pilot feasibility, execute the same corpus under each model × quantization × protocol, preserving failures and environment provenance.
4. Semantic evaluation: run safe, independent target-language validators and policy-specific assertions before choosing a default or fallback model.
5. Controls: implement native FIM/seq2seq adapters for StarCoder2 and CodeT5-class controls, then include them with appropriately equivalent tasks. A hosted oracle needs explicit permission and a reviewed synthetic-only dataset.

A passing synthetic HTTP mock test validates the *runner*, not the models. The matrix is intentionally a local, resumable execution ledger so expensive computations remain under the operator's control.
