'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-model-smoke-'));
const collected = [];

async function run(command, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env } });
        let stdout = '', stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
}

async function main() {
    const server = http.createServer((req, res) => {
        let payload = '';
        req.on('data', (b) => { payload += b; });
        req.on('end', () => {
            collected.push(payload);
            const request = JSON.parse(payload);
            const system = request.messages[0].content;
            let response;
            if (system.includes('SEARCH/REPLACE anchors')) {
                response = { edits: [{ search: 'x + 1', replace: 'x + 2' }] };
            } else {
                response = { text: 'result = [x + 2 for x in values]' };
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                choices: [{ message: { content: JSON.stringify(response) } }],
                usage: { prompt_tokens: 42 },
            }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions';
    const env = {
        PROJECTION_BENCH_ENDPOINT: endpoint,
        PROJECTION_BENCH_MODEL: 'synthetic-http-mock-NOT-A-MODEL',
        PROJECTION_BENCH_CASE: 'linq-eager-001',
        PROJECTION_BENCH_PROTOCOLS: 'full-rewrite,update-instruction,grounded-micro-edit',
        PROJECTION_BENCH_OUTPUT: path.join(dir, 'recorded.json'),
    };
    try {
        const recorded = await run(process.execPath, [path.join(root, 'benchmarks', 'record-model.js')], env);
        assert.equal(recorded.code, 0, recorded.stderr);
        const attempts = JSON.parse(fs.readFileSync(env.PROJECTION_BENCH_OUTPUT, 'utf8'));
        assert.equal(attempts.length, 3);
        assert.equal(collected.length, 3);
        assert(attempts.every((a) => a.elapsedMs >= 0 && a.outboundTokens === 42));
        assert(attempts.every((a) => a.outboundCanaryPresent === false));
        assert(attempts.every((a) => a.outboundCharacters > 0));
        const scored = await run(process.execPath, [
            path.join(root, 'benchmarks', 'run.js'), env.PROJECTION_BENCH_OUTPUT,
        ], {});
        assert.equal(scored.code, 0, scored.stderr);
        const result = JSON.parse(scored.stdout);
        assert.equal(result.rows.length, 3);
        assert(result.rows.every((r) => r.status === 'accepted' && r.referenceExact === true));
        assert.equal(result.rows.filter((r) => r.patchSuccess === true).length, 1);

        collected.length = 0;
        const privacyEnv = {
            ...env,
            PROJECTION_BENCH_CASE: 'interpolation-privacy-001',
            PROJECTION_BENCH_PROTOCOLS: 'full-rewrite',
            PROJECTION_BENCH_OUTPUT: path.join(dir, 'canary.json'),
        };
        const privateRun = await run(process.execPath, [path.join(root, 'benchmarks', 'record-model.js')], privacyEnv);
        assert.equal(privateRun.code, 0, privateRun.stderr);
        assert.equal(collected.length, 3);
        assert(collected.some((s) => s.includes('__REDACTED_CANARY_0__')));
        assert(collected.every((s) => !s.includes('CANARY_SYNTHETIC_NOT_SECRET')));
        const remote = await run(process.execPath, [path.join(root, 'benchmarks', 'record-model.js')], {
            ...env, PROJECTION_BENCH_ENDPOINT: 'https://example.com/v1/chat/completions',
            PROJECTION_BENCH_OUTPUT: path.join(dir, 'remote.json'),
        });
        assert.notEqual(remote.code, 0);
        assert.match(remote.stderr, /Remote model endpoints require PROJECTION_BENCH_ALLOW_REMOTE=1/);
        assert(!fs.existsSync(path.join(dir, 'remote.json')));
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
    console.log('model recorder smoke: PASS (mock only, no model inference)');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
