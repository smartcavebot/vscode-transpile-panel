'use strict';

/**
 * Local-first real model recorder, compatible with Ollama/vLLM/llama.cpp
 * servers exposing /v1/chat/completions. Never calls a hosted endpoint by default.
 *
 * Required: PROJECTION_BENCH_ENDPOINT, PROJECTION_BENCH_MODEL.
 * Optional: PROJECTION_BENCH_PROTOCOLS, PROJECTION_BENCH_CASE,
 * PROJECTION_BENCH_QUANTIZATION, PROJECTION_BENCH_OUTPUT, PROJECTION_BENCH_API_KEY,
 * PROJECTION_BENCH_ALLOW_REMOTE=1 (explicit remote opt-in).
 *
 * All requests sequential. Raw source payloads are not written to diagnostics.
 */
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { loadTrajectories, compileCore } = require('./run');

const endpoint = process.env.PROJECTION_BENCH_ENDPOINT;
const modelId = process.env.PROJECTION_BENCH_MODEL;
const protocolList = (process.env.PROJECTION_BENCH_PROTOCOLS || 'full-rewrite,update-instruction,grounded-micro-edit')
    .split(',').map((x) => x.trim()).filter(Boolean);
const allowedProtocols = ['full-rewrite', 'update-instruction', 'grounded-micro-edit'];
const maximumCharacters = positiveInteger(process.env.PROJECTION_BENCH_MAX_CHARACTERS || '12000');
const maximumOutputTokens = positiveInteger(process.env.PROJECTION_BENCH_MAX_OUTPUT_TOKENS || '2048');
const outputFile = path.resolve(process.env.PROJECTION_BENCH_OUTPUT || 'benchmarks/attempts.recorded.json');

function positiveInteger(text) {
    const number = Number(text);
    if (!Number.isInteger(number) || number <= 0) {
        throw new Error('Benchmark limits must be positive integers.');
    }
    return number;
}

function assertEndpoint() {
    if (!endpoint || !modelId) {
        throw new Error('Set PROJECTION_BENCH_ENDPOINT and PROJECTION_BENCH_MODEL explicitly.');
    }
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Model endpoint must be HTTP(S).');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!loopback && process.env.PROJECTION_BENCH_ALLOW_REMOTE !== '1') {
        throw new Error('Remote model endpoints require PROJECTION_BENCH_ALLOW_REMOTE=1.');
    }
    if (!loopback && url.protocol !== 'https:') {
        throw new Error('Remote model endpoints require TLS.');
    }
    if (!url.pathname.endsWith('/chat/completions')) {
        throw new Error('Model endpoint must point to /chat/completions.');
    }
    if (url.username || url.password) {
        throw new Error('Credentials must not appear in the endpoint URL.');
    }
    for (const p of protocolList) {
        if (!allowedProtocols.includes(p)) throw new Error('Unknown protocol: ' + p);
    }
}

function protect(text, canaries) {
    let result = text;
    for (const [i, canary] of canaries.entries()) {
        if (!canary) throw new Error('Empty privacy canary.');
        result = result.split(canary).join('__REDACTED_CANARY_' + i + '__');
    }
    return result;
}

function restore(text, canaries) {
    let result = text;
    for (const [i, canary] of canaries.entries()) {
        result = result.split('__REDACTED_CANARY_' + i + '__').join(canary);
    }
    return result;
}

function requestBody(trajectory, source, previousSource, target, step, protocol) {
    const canaries = trajectory.canaries || [];
    const policy = trajectory.policy || { id: 'default', choices: {} };
    const harness = trajectory.harness || { id: 'none', facilities: [] };
    const local = {
        sourceLanguage: trajectory.sourceLanguage,
        targetLanguage: trajectory.targetLanguage,
        semanticPolicy: policy,
        harness,
        sourceBefore: previousSource,
        sourceAfter: source,
        sourceEdits: step.edits,
        previousTarget: protocol === 'full-rewrite' ? undefined : target,
        sourceIsSyntacticallyComplete: step.sourceIsSyntacticallyComplete ?? null,
    };
    const targetRequest = protocol === 'grounded-micro-edit'
        ? 'Return a JSON object with an edits array of exact, unique SEARCH/REPLACE anchors: {"edits":[{"search":"...","replace":"..."}]}. Make the minimum grounded edits to previousTarget. No regex or fuzzy matching.'
        : protocol === 'update-instruction'
            ? 'Return a JSON object {"text":"..."} containing the updated target text. Preserve unrelated previous target code.'
            : 'Return a JSON object {"text":"..."} containing a fresh complete translation of sourceAfter. Do not use previous target.';
    const system = [
        'You are a deterministic code translation benchmark participant.',
        'Translate the provided source edits into the target language according to semanticPolicy.',
        'Incomplete source states are valid input; output best-effort target code.',
        'Emit only valid JSON, no markdown code fences or commentary.',
        targetRequest,
    ].join(' ');
    const user = JSON.stringify(local);
    const messages = [
        { role: 'system', content: protect(system, canaries) },
        { role: 'user', content: protect(user, canaries) },
    ];
    const body = JSON.stringify({
        model: modelId,
        temperature: 0,
        max_tokens: maximumOutputTokens,
        messages,
    });
    if (body.length > maximumCharacters) {
        throw new Error('outbound-context-cap-exceeded');
    }
    const leakage = canaries.some((x) => body.includes(x));
    if (leakage) throw new Error('privacy-canary-leakage-blocked');
    return { body, canaries, leakage };
}

function normalizeResponse(content, protocol, canaries) {
    if (typeof content !== 'string') return { kind: 'error', code: 'missing-content' };
    let parsed;
    try { parsed = JSON.parse(content.trim()); }
    catch { return { kind: 'error', code: 'malformed-json' }; }
    if (!parsed || typeof parsed !== 'object') return { kind: 'error', code: 'malformed-response' };
    if (protocol === 'grounded-micro-edit') {
        if (!Array.isArray(parsed.edits) ||
            parsed.edits.some((edit) => !edit || typeof edit.search !== 'string' || typeof edit.replace !== 'string')) {
            return { kind: 'error', code: 'malformed-patch' };
        }
        return { kind: 'patch', edits: parsed.edits.map((x) => ({
            search: restore(x.search, canaries),
            replace: restore(x.replace, canaries),
        })) };
    }
    if (typeof parsed.text !== 'string') return { kind: 'error', code: 'malformed-text' };
    return { kind: 'text', text: restore(parsed.text, canaries) };
}

async function query(body, protocol, canaries) {
    let result, json;
    const start = performance.now();
    try {
        result = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.PROJECTION_BENCH_API_KEY
                    ? { Authorization: 'Bearer ' + process.env.PROJECTION_BENCH_API_KEY } : {}),
            },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(120000),
        });
        if (!result.ok) return {
            response: { kind: 'error', code: 'http-' + result.status },
            elapsedMs: performance.now() - start, outboundTokens: null,
        };
        json = await result.json();
    } catch {
        return {
            response: { kind: 'error', code: 'transport-error' },
            elapsedMs: performance.now() - start, outboundTokens: null,
        };
    }
    const content = json?.choices?.[0]?.message?.content;
    return {
        response: normalizeResponse(content, protocol, canaries),
        elapsedMs: performance.now() - start,
        outboundTokens: Number.isInteger(json?.usage?.prompt_tokens)
            ? json.usage.prompt_tokens : null,
    };
}

async function main() {
    assertEndpoint();
    const trajectories = loadTrajectories();
    const selected = process.env.PROJECTION_BENCH_CASE;
    if (selected && !trajectories.has(selected)) {
        throw new Error('Unknown benchmark case: ' + selected);
    }
    const core = compileCore();
    const attempts = [];
    try {
        for (const trajectory of trajectories.values()) {
            if (selected && selected !== trajectory.id) continue;
            for (const protocol of protocolList) {
                let source = trajectory.initialSource;
                let previousTarget = trajectory.initialTarget;
                let revision = 0;
                for (const step of trajectory.steps) {
                    const nextSource = step.expectedSource;
                    const input = requestBody(trajectory, nextSource, source, previousTarget, step, protocol);
                    const measurement = await query(input.body, protocol, input.canaries);
                    const response = measurement.response;
                    attempts.push({
                        caseId: trajectory.id, stepId: step.id, modelId,
                        providerId: 'openai-compatible',
                        quantization: process.env.PROJECTION_BENCH_QUANTIZATION || null,
                        protocol, elapsedMs: measurement.elapsedMs,
                        outboundCharacters: input.body.length,
                        outboundTokens: measurement.outboundTokens,
                        outboundCanaryPresent: input.leakage,
                        response,
                    });
                    revision++;
                    if (response.kind === 'text') {
                        previousTarget = response.text;
                    } else if (response.kind === 'patch') {
                        try {
                            previousTarget = core.applyGroundedPatch(previousTarget, revision, {
                                revision, edits: response.edits,
                            }).text;
                        } catch { /* rejected patch preserves previous target */ }
                    }
                    source = nextSource;
                }
            }
        }
    } finally {
        fs.rmSync(core.outDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(attempts, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ output: outputFile, attempts: attempts.length, modelId, protocols: protocolList }) + '\n');
}

main().catch((error) => {
    process.stderr.write('model recording failed: ' + error.message + '\n');
    process.exitCode = 1;
});
