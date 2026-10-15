'use strict';

/**
 * Host-neutral, recorded-attempt benchmark.
 *
 * Usage: node benchmarks/run.js [attempts.json]
 * Emits JSON to stdout; diagnostics only to stderr.
 * Deliberately does NOT execute a model or infer semantic equivalence from text equality.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const casesDir = path.join(__dirname, 'cases');
const attemptsPath = path.resolve(process.argv[2] || path.join(__dirname, 'attempts.fixture.json'));

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function loadTrajectories() {
    const cases = new Map();
    for (const file of fs.readdirSync(casesDir).filter((f) => f.endsWith('.json')).sort()) {
        const input = readJson(path.join(casesDir, file));
        assert(input.version === 1 && typeof input.id === 'string', `Invalid trajectory: ${file}`);
        assert(!cases.has(input.id), `Duplicate trajectory id: ${input.id}`);
        assert(Array.isArray(input.steps) && input.steps.length > 0, `Empty trajectory: ${file}`);
        let source = input.initialSource;
        const states = new Map();
        for (const [index, step] of input.steps.entries()) {
            assert(!states.has(step.id), `Duplicate step: ${input.id}/${step.id}`);
            source = applySourceEdits(source, step.edits, `${input.id}/${step.id}`);
            assert(source === step.expectedSource, `Trajectory expectedSource mismatch: ${input.id}/${step.id}`);
            states.set(step.id, { ...step, ordinal: index + 1, source });
        }
        cases.set(input.id, { ...input, states });
    }
    return cases;
}

function applySourceEdits(source, edits, label) {
    assert(Array.isArray(edits) && edits.length > 0, `Missing source edits: ${label}`);
    const sorted = [...edits].sort((a, b) =>
        a.rangeOffset - b.rangeOffset || a.rangeLength - b.rangeLength,
    );
    let previousEnd = -1;
    for (const edit of sorted) {
        assert(Number.isInteger(edit.rangeOffset) && edit.rangeOffset >= 0 &&
            Number.isInteger(edit.rangeLength) && edit.rangeLength >= 0 &&
            typeof edit.text === 'string', `Invalid source edit: ${label}`);
        assert(edit.rangeOffset >= previousEnd &&
            edit.rangeOffset + edit.rangeLength <= source.length,
            `Overlapping/out-of-bounds source edit: ${label}`);
        previousEnd = edit.rangeOffset + edit.rangeLength;
    }
    return [...sorted].reverse().reduce((text, edit) =>
        text.slice(0, edit.rangeOffset) + edit.text +
        text.slice(edit.rangeOffset + edit.rangeLength), source);
}

function compileCore() {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-benchmark-'));
    const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
    const result = spawnSync(process.execPath, [
        tsc, '-p', path.join(root, 'tsconfig.core-test.json'), '--outDir', outDir,
    ], { cwd: root, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
        fs.rmSync(outDir, { recursive: true, force: true });
        throw new Error(result.error?.message || result.stderr || result.stdout || 'Core compile failed');
    }
    return { applyGroundedPatch: require(path.join(outDir, 'core', 'index.js')).applyGroundedPatch, outDir };
}

function differenceSpan(before, after) {
    let prefix = 0;
    const limit = Math.min(before.length, after.length);
    while (prefix < limit && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < limit - prefix &&
        before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
    return (before.length - prefix - suffix) + (after.length - prefix - suffix);
}

function percentile(values, fraction) {
    if (values.length === 0) return null;
    const ordered = [...values].sort((a, b) => a - b);
    const position = (ordered.length - 1) * fraction;
    const low = Math.floor(position), high = Math.ceil(position);
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low);
}

function pythonSyntax(text) {
    const command = process.env.PROJECTION_BENCH_PYTHON || 'python3';
    const processResult = spawnSync(command, [
        '-c', 'import ast,sys;ast.parse(sys.stdin.read())',
    ], { input: text, encoding: 'utf8', timeout: 2000 });
    if (processResult.error?.code === 'ENOENT') return null;
    if (processResult.error) return null;
    return processResult.status === 0;
}

function main() {
    const trajectories = loadTrajectories();
    const attempts = readJson(attemptsPath);
    assert(Array.isArray(attempts), 'Attempts input must be an array.');
    const groups = new Map();

    for (const attempt of attempts) {
        assert(attempt && typeof attempt === 'object', 'Malformed attempt object.');
        const trajectory = trajectories.get(attempt.caseId);
        assert(trajectory, `Unknown trajectory: ${attempt.caseId}`);
        assert(trajectory.states.has(attempt.stepId),
            `Unknown step: ${attempt.caseId}/${attempt.stepId}`);
        assert(['full-rewrite', 'update-instruction', 'grounded-micro-edit'].includes(attempt.protocol),
            `Unknown protocol: ${attempt.protocol}`);
        assert(typeof attempt.modelId === 'string' && attempt.modelId.length > 0,
            'Missing model identity.');
        const model = {
            id: attempt.modelId,
            provider: attempt.providerId ?? null,
            quantization: attempt.quantization ?? null,
        };
        const key = JSON.stringify([attempt.caseId, model, attempt.protocol]);
        if (!groups.has(key)) groups.set(key, {
            trajectory, model, protocol: attempt.protocol, attempts: new Map(),
        });
        const group = groups.get(key);
        assert(!group.attempts.has(attempt.stepId), `Duplicate attempt: ${key}/${attempt.stepId}`);
        group.attempts.set(attempt.stepId, attempt);
    }

    const core = compileCore();
    try {
        const rows = [];
        const summaries = [];
        for (const group of groups.values()) {
            const { trajectory, model, protocol } = group;
            let previousTarget = trajectory.initialTarget;
            const groupRows = [];
            for (const state of trajectory.states.values()) {
                const attempt = group.attempts.get(state.id);
                let acceptedText = null, patchSuccess = null, failureCode = null;
                if (attempt) {
                    const response = attempt.response;
                    assert(response && typeof response === 'object', 'Missing response.');
                    if (protocol === 'grounded-micro-edit') {
                        assert(response.kind === 'patch' && Array.isArray(response.edits),
                            'Grounded micro-edit requires a patch response.');
                        try {
                            acceptedText = core.applyGroundedPatch(previousTarget, state.ordinal, {
                                revision: state.ordinal, edits: response.edits,
                            }).text;
                            patchSuccess = true;
                        } catch (error) {
                            patchSuccess = false;
                            failureCode = error.code || 'unclassified-patch-error';
                        }
                    } else {
                        assert(response.kind === 'text' && typeof response.text === 'string',
                            'Rewrite/update protocol requires a text response.');
                        acceptedText = response.text;
                    }
                }

                const churn = acceptedText === null ? null : differenceSpan(previousTarget, acceptedText);
                const syntaxValid = acceptedText === null || trajectory.targetLanguage !== 'python'
                    ? null : pythonSyntax(acceptedText);
                const referenceExact = acceptedText === null || !state.referenceTargets
                    ? null : state.referenceTargets.includes(acceptedText);
                const row = {
                    caseId: trajectory.id,
                    stepId: state.id,
                    stepOrdinal: state.ordinal,
                    category: trajectory.category,
                    sourceComplete: state.sourceIsSyntacticallyComplete ?? null,
                    model,
                    protocol,
                    status: !attempt ? 'missing' : acceptedText === null ? 'rejected' : 'accepted',
                    patchSuccess,
                    failureCode,
                    referenceExact,
                    pythonSyntaxValid: syntaxValid,
                    semanticEquivalence: null,
                    policyAdherence: null,
                    targetCharacters: acceptedText?.length ?? null,
                    churnCharacters: churn,
                    latencyMs: attempt?.elapsedMs ?? null,
                    outboundCharacters: attempt?.outboundCharacters ?? null,
                    outboundTokens: attempt?.outboundTokens ?? null,
                    outboundCanaryPresent: attempt?.outboundCanaryPresent ?? null,
                    timeToValidPatchMs: attempt && patchSuccess === true && syntaxValid === true
                        ? attempt.elapsedMs ?? null : null,
                };
                groupRows.push(row);
                rows.push(row);
                if (acceptedText !== null) previousTarget = acceptedText;
            }
            const validPatchTimes = groupRows.map((row) => row.timeToValidPatchMs)
                .filter((n) => typeof n === 'number');
            const latencies = groupRows.map((row) => row.latencyMs)
                .filter((n) => typeof n === 'number');
            summaries.push({
                caseId: trajectory.id, model, protocol,
                steps: groupRows.length,
                accepted: groupRows.filter((r) => r.status === 'accepted').length,
                rejected: groupRows.filter((r) => r.status === 'rejected').length,
                missing: groupRows.filter((r) => r.status === 'missing').length,
                referenceExact: {
                    matched: groupRows.filter((r) => r.referenceExact === true).length,
                    evaluated: groupRows.filter((r) => r.referenceExact !== null).length,
                },
                latencyP50Ms: percentile(latencies, 0.5),
                latencyP95Ms: percentile(latencies, 0.95),
                timeToValidPatchP50Ms: percentile(validPatchTimes, 0.5),
                timeToValidPatchP95Ms: percentile(validPatchTimes, 0.95),
            });
        }
        process.stdout.write(JSON.stringify({
            schemaVersion: 1,
            benchmark: 'csharp-python-incremental-projection',
            attemptsFile: path.relative(root, attemptsPath),
            rows, summaries,
            limitations: [
                'referenceExact is string agreement, not semantic equivalence',
                'policy adherence and semantic equivalence require external evaluators',
                'outbound leakage requires provider-boundary instrumentation',
                'unknown metrics remain null',
            ],
        }, null, 2) + '\n');
    } finally {
        fs.rmSync(core.outDir, { recursive: true, force: true });
    }
}
try { main(); }
catch (error) {
    process.stderr.write(`benchmark failed: ${error.stack || error}\n`);
    process.exitCode = 1;
}
