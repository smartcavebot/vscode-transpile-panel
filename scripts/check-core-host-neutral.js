'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'src', 'core');
const violations = [];

for (const file of walk(root)) {
    if (!file.endsWith('.ts')) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/\bfrom\s+['"]vscode['"]|\brequire\(\s*['"]vscode['"]\s*\)|\bimport\(\s*['"]vscode['"]\s*\)/.test(text)) {
        violations.push(path.relative(path.resolve(__dirname, '..'), file));
    }
}

if (violations.length) {
    console.error('Host-neutrality violation: src/core must not import vscode:');
    for (const file of violations) console.error(`  - ${file}`);
    process.exit(1);
}

console.log('core host-neutrality guard: PASS');

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else yield full;
    }
}
