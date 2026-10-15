'use strict';
const assert = require('node:assert/strict');
const { loadTrajectories } = require('./run');

const corpus = loadTrajectories(); // Replays every old-coordinate edit and checks expectedSource.
const categories = new Set([...corpus.values()].map((c) => c.category));
const steps = [...corpus.values()].flatMap((c) => [...c.states.values()]);
assert(corpus.size >= 16, 'Expected expanded trajectory corpus');
assert(categories.size >= 14, 'Expected diverse language constructs');
assert(steps.length >= 40, 'Expected multi-step edit trajectories');
assert(steps.some((step) => step.sourceIsSyntacticallyComplete === false),
    'Missing intentionally incomplete editor states');
assert(steps.some((step) => step.edits.length > 1),
    'Missing atomic multi-change editor event');
assert([...corpus.values()].some((c) => (c.canaries || []).length > 0),
    'Missing privacy canary cases');
assert(steps.some((step) => step.referenceTargets === undefined),
    'Incomplete/ambiguous states must be representable without invented references');
for (const c of corpus.values()) {
    assert(c.steps.length > 0);
    for (const step of c.steps) {
        assert(step.edits.length > 0);
        assert(typeof step.expectedSource === 'string');
        assert(step.referenceTargets === undefined ||
            step.referenceTargets.every((x) => typeof x === 'string'));
    }
}
console.log(`trajectory corpus: PASS (${corpus.size} cases, ${steps.length} edits, ${categories.size} categories)`);
