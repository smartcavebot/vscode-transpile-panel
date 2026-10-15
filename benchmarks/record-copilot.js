'use strict';

/**
 * GitHub Copilot SDK hosted-oracle lane for synthetic C#→Python trajectories.
 *
 * This is intentionally independent from the Q4/Q5/Q8 local-weight matrix:
 * GitHub Copilot exposes model choices, not operator-controlled quantizations.
 * No inference happens unless invoked explicitly (workflow_dispatch).
 */
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { loadTrajectories, compileCore } = require('./run');

const PROTOCOLS = new Set(['full-rewrite', 'update-instruction', 'grounded-micro-edit']);

function assert(value, message) {
    if (!value) throw new Error(message);
}

function replaceCanaries(input, canaries) {
    let text = input;
    for (const [index, canary] of canaries.entries()) {
        assert(typeof canary === 'string' && canary.length > 0, 'Invalid synthetic canary');
        const marker = '__BENCH_REDACTED_CANARY_' + index + '__';
        assert(!text.includes(marker), 'Synthetic privacy placeholder collision');
        text = text.split(canary).join(marker);
    }
    return text;
}

function restoreCanaries(input, canaries) {
    let text = input;
    canaries.forEach((canary, index) => {
        text = text.split('__BENCH_REDACTED_CANARY_' + index + '__').join(canary);
    });
    return text;
}

function buildPrompt(trajectory, step, priorSource, previousTarget, protocol) {
    assert(PROTOCOLS.has(protocol), 'Invalid update protocol');
    const policy = trajectory.policy || { id: 'default', choices: {} };
    const payload = {
        sourceLanguage: trajectory.sourceLanguage,
        targetLanguage: trajectory.targetLanguage,
        policy,
        harness: trajectory.harness || { id: 'none', facilities: [] },
        sourceBefore: priorSource,
        sourceAfter: step.expectedSource,
        sourceEdits: step.edits,
        sourceIsSyntacticallyComplete: step.sourceIsSyntacticallyComplete ?? null,
        ...(protocol === 'full-rewrite' ? {} : { previousTarget }),
    };
    const format = protocol === 'grounded-micro-edit'
        ? 'Return ONLY JSON {"edits":[{"search":"exact unique old target span","replace":"new span"}]}. Each SEARCH must have a unique exact match in previousTarget. No fuzzy matching.'
        : protocol === 'update-instruction'
            ? 'Return ONLY JSON {"text":"updated target text"} preserving unrelated previous target.'
            : 'Return ONLY JSON {"text":"complete fresh translation"} without depending on the previous target.';
    const prompt = [
        'This is a controlled, synthetic code-transpilation benchmark.',
        'Translate the C# editing state into Python following the given semantic policy.',
        'Incomplete source states are intentional test inputs.',
        'Do not execute commands, access tools or perform external actions.',
        format,
        JSON.stringify(payload),
    ].join('\n\n');
    const canaries = trajectory.canaries || [];
    const outbound = replaceCanaries(prompt, canaries);
    assert(!canaries.some((canary) => outbound.includes(canary)),
        'Synthetic canary was not redacted');
    return { outbound, canaries };
}

function normalize(text, protocol, canaries) {
    if (typeof text !== 'string') return { kind: 'error', code: 'missing-content' };
    let decoded;
    try { decoded = JSON.parse(text.trim()); }
    catch { return { kind: 'error', code: 'malformed-json' }; }
    if (!decoded || typeof decoded !== 'object') {
        return { kind: 'error', code: 'malformed-response' };
    }
    if (protocol === 'grounded-micro-edit') {
        if (!Array.isArray(decoded.edits) || decoded.edits.some((edit) =>
            !edit || typeof edit.search !== 'string' || typeof edit.replace !== 'string')) {
            return { kind: 'error', code: 'malformed-patch' };
        }
        return { kind: 'patch', edits: decoded.edits.map((edit) => ({
            search: restoreCanaries(edit.search, canaries),
            replace: restoreCanaries(edit.replace, canaries),
        })) };
    }
    if (typeof decoded.text !== 'string') return { kind: 'error', code: 'malformed-text' };
    return { kind: 'text', text: restoreCanaries(decoded.text, canaries) };
}

function settings(environment = process.env) {
    const caseId = environment.PROJECTION_BENCH_COPILOT_CASE;
    const protocol = environment.PROJECTION_BENCH_COPILOT_PROTOCOL;
    const modelId = environment.PROJECTION_BENCH_COPILOT_MODEL;
    const output = environment.PROJECTION_BENCH_COPILOT_OUTPUT;
    const maxRequests = Number(environment.PROJECTION_BENCH_COPILOT_MAX_REQUESTS || '1');
    assert(caseId && /^[a-z0-9][a-z0-9-]*$/i.test(caseId), 'Explicit trajectory is required');
    assert(PROTOCOLS.has(protocol), 'Explicit supported protocol is required');
    assert(modelId && /^[a-z0-9][a-z0-9_.:/-]*$/i.test(modelId), 'Explicit Copilot model id is required');
    assert(output, 'Explicit output file is required');
    assert(Number.isInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 5,
        'Request cap must be an integer from 1 through 5');
    return { caseId, protocol, modelId, output: path.resolve(output), maxRequests };
}

async function record(send, config, trajectories, applyGroundedPatch) {
    const trajectory = trajectories.get(config.caseId);
    assert(trajectory, 'Unknown synthetic trajectory');
    assert(trajectory.steps.length <= config.maxRequests,
        'Trajectory exceeds explicit billed request cap');
    const attempts = [];
    let previousTarget = trajectory.initialTarget;
    let previousSource = trajectory.initialSource;
    for (const [i, step] of trajectory.steps.entries()) {
        const { outbound, canaries } = buildPrompt(
            trajectory, step, previousSource, previousTarget, config.protocol,
        );
        assert(outbound.length <= 12000, 'Prompt exceeds 12000-character safety cap');
        const start = performance.now();
        let response;
        try {
            const result = await send(config.modelId, outbound);
            response = normalize(result, config.protocol, canaries);
        } catch {
            // Do not include raw exception messages or model prompts in traces.
            response = { kind: 'error', code: 'copilot-request-error' };
        }
        attempts.push({
            caseId: config.caseId,
            stepId: step.id,
            modelId: config.modelId,
            providerId: 'github-copilot-sdk',
            quantization: null,
            protocol: config.protocol,
            elapsedMs: performance.now() - start,
            outboundCharacters: outbound.length,
            outboundTokens: null,
            outboundCanaryPresent: false,
            response,
        });
        if (response.kind === 'text') {
            previousTarget = response.text;
        } else if (response.kind === 'patch') {
            try {
                previousTarget = applyGroundedPatch(previousTarget, i + 1, {
                    revision: i + 1, edits: response.edits,
                }).text;
            } catch {
                // A rejected patch does not update target state.
            }
        }
        previousSource = step.expectedSource;
    }
    return attempts;
}

async function main() {
    const config = settings();
    assert(process.env.GITHUB_TOKEN || process.env.COPILOT_GITHUB_TOKEN,
        'Copilot authentication token is required');
    const trajectories = loadTrajectories();
    const core = compileCore();
    let client;
    try {
        // Installed only in the manual Actions workflow; routine CI needs no SDK.
        const { CopilotClient } = await import('@github/copilot-sdk');
        client = new CopilotClient({ mode: 'empty' });
        await client.start();
        const attempts = await record(async (modelId, prompt) => {
            // Isolated session per request. No ambient shell/filesystem/MCP tools,
            // plugins or repository agent behaviors are allowed in empty mode.
            const session = await client.createSession({
                model: modelId,
                availableTools: [],
            });
            try {
                const result = await session.sendAndWait({ prompt }, 120000);
                return result?.data?.content ?? null;
            } finally {
                await session.disconnect();
            }
        }, config, trajectories, core.applyGroundedPatch);
        fs.mkdirSync(path.dirname(config.output), { recursive: true, mode: 0o700 });
        fs.writeFileSync(config.output, JSON.stringify(attempts, null, 2) + '\n',
            { flag: 'wx', mode: 0o600 });
        process.stdout.write(JSON.stringify({
            status: 'recorded',
            modelId: config.modelId,
            caseId: config.caseId,
            protocol: config.protocol,
            requests: attempts.length,
            errors: attempts.filter((a) => a.response.kind === 'error').length,
            output: config.output,
            note: 'Hosted Copilot inference; no quantization control or reported token counts.',
        }) + '\n');
    } finally {
        if (client) await client.stop();
        fs.rmSync(core.outDir, { recursive: true, force: true });
    }
}

module.exports = { settings, buildPrompt, normalize, record, replaceCanaries, restoreCanaries };
if (require.main === module) {
    main().catch((error) => {
        process.stderr.write('Copilot benchmark failed: ' + error.message + '\n');
        process.exitCode = 1;
    });
}
