# GitHub Actions hosted-oracle lane (SMA-246)

GitHub **Models** (the standalone hosted inference service) was fully retired on July 30, 2026. GitHub **Copilot** remains available through the Copilot SDK and CLI, including within GitHub Actions using `GITHUB_TOKEN` and `copilot-requests: write` permission. This workflow is a **hosted reference comparison** lane, not a substitute for operator-controlled Q4/Q5/Q8 model weights.

## Execute manually

From the repository Actions tab, choose **Copilot hosted-oracle benchmark** and **Run workflow**. Select a Copilot model ID actually enabled for the organization, a synthetic trajectory ID (default `linq-eager-001`), and one protocol. Set the request cap and explicitly acknowledge organization billing. The action does not run on pushes or PRs, and the acknowledgment defaults to false.

The organization must permit **Allow use of Copilot CLI billed to the organization**. Without that policy, GitHub token-based Copilot SDK authentication may fail; no personal access token is required when the organization is configured correctly.

The job uses Node 22, installs `@github/copilot-sdk@1.0.19` only for the manually triggered workflow, creates a fresh `mode: "empty"` SDK session with `availableTools: []` per request, and uses the existing trajectory and core grounded-patch acceptance contract. No shell/filesystem/MCP tools are available to the model, and it does not automatically inspect repository source code. Only the explicitly selected synthetic fixture is submitted.

The runner enforces a maximum of 5 requests (default 1), 12,000 prompt characters per request, and a single case/protocol. Synthetic privacy canaries are redacted before prompts are sent. This is not a general scanner for secrets; only reviewed synthetic fixtures should be used.

The output is scored by the existing `benchmarks/run.js` and uploaded as a seven-day Actions artifact containing raw attempts and scores, both of which may include synthetic source/target text. They are **not** committed. Format errors and model request failures are recorded as failures; no false success or synthetic latency is generated.

## Evidence boundaries

- GitHub Copilot SDK exposes hosted models but does **not** provide known model-weight quantization controls. Its results must not populate Qwen2.5-Coder Q4/Q5/Q8 cells.
- Recorded latency includes SDK session setup and response waiting. Copilot's internal prompt-token count is unknown to this adapter (recorded as `null`).
- Agentic/SDK transport differs from the raw OpenAI-compatible chat-completions transport. Treat scores as an **external reference lane** rather than an apples-to-apples throughput comparison.
- Empty-mode session isolation and an explicit tool allow-list prevent workspace tool use by default; they do not promise that the hosted provider itself is local or confidential.
- The workflow requires **manual triggering and approval of billed usage**. Normal pull-request CI only executes mock/stub tests; it does not contact Copilot.
- Official GitHub Models retirement announcement: https://github.blog/changelog/2026-07-30-github-models-is-now-retired/
- Copilot Actions authorization: https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions

The locally quantized model comparison remains documented in `benchmarks/MATRIX.md`; run it on an actual model server or suitable self-hosted GPU Actions runner when those weights are available.
