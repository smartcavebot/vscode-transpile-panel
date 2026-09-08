'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.core-test');
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

fs.rmSync(outDir, { recursive: true, force: true });

try {
    run(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.core-test.json')]);
    run(process.execPath, [path.join(root, 'tests', 'core-smoke.js')]);
} finally {
    fs.rmSync(outDir, { recursive: true, force: true });
}

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
    });

    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
