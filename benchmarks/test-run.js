'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = path.join(__dirname, 'run.js');
const result = spawnSync(process.execPath, [runner], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 30000,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr || 'benchmark failed');

const output = JSON.parse(result.stdout);
assert.equal(output.schemaVersion, 1);
assert.equal(output.rows.length, 7);
assert.equal(output.summaries.length, 3);
assert.equal(output.rows.filter((row) => row.patchSuccess === true).length, 4);
assert.equal(output.rows.filter((row) => row.status === 'accepted').length, 7);
assert.equal(output.rows.filter((row) => row.referenceExact === true).length, 5);
assert.equal(output.rows.filter((row) => row.referenceExact === null).length, 2);
assert(output.rows.every((row) => row.semanticEquivalence === null));
assert(output.rows.every((row) => row.policyAdherence === null));
assert(output.rows.every((row) => row.latencyMs === null));
assert(output.summaries.every((row) => row.latencyP50Ms === null));
assert(output.rows.every((row) => row.outboundCanaryPresent === null));
console.log('trajectory benchmark smoke: PASS');
