'use strict';
const assert = require('node:assert/strict');
const {
    ProjectionSession,
    TargetProjectionBuffer,
    selectCoverageRequirement,
    stabilizeProjectionRequirement,
} = require('../.core-test/core');

async function main() {
    const source = 'alpha beta gamma delta';
    const original = { id: 'policy-v1', choices: { linq: 'lazy' } };
    const revised = { id: 'policy-v1', choices: { linq: 'eager' } };
    const harness = { id: 'none', targetLanguage: 'python', facilities: [] };
    const session = new ProjectionSession({
        sourceLanguage: 'csharp',
        targetLanguage: 'python',
        contextLines: 0,
        maxContextCharacters: 8,
        policy: original,
        harness,
    });
    const buffer = new TargetProjectionBuffer(0);
    const firstRevision = session.invalidate();
    buffer.rebase([], firstRevision);
    buffer.applyProjection({ start: 0, end: 6 }, 'old-a', firstRevision);
    buffer.applyProjection({ start: 6, end: 12 }, 'old-b', firstRevision);
    buffer.applyProjection({ start: 12, end: 18 }, 'old-c', firstRevision);
    buffer.applyProjection({ start: 18, end: source.length }, 'old-d', firstRevision);
    assert.equal(buffer.freshCoverageGaps(source.length).length, 0);

    let release;
    const requests = [];
    const provider = {
        id: 'deferred',
        project(request) {
            requests.push(request);
            if (requests.length === 1) {
                return new Promise((resolve) => { release = () => resolve({
                    revision: request.revision,
                    text: 'should-never-commit',
                }); });
            }
            return Promise.resolve({
                revision: request.revision,
                text: 'new:' + request.focusRegion,
            });
        },
    };

    session.requireProjectionRange({ start: 0, end: 6 });
    const pending = session.refresh(document(source), provider);
    assert.equal(requests[0].policy.choices.linq, 'lazy');
    assert.equal(session.reconfigure(original, harness), undefined);

    const revision = session.reconfigure(revised, harness);
    assert.equal(revision, firstRevision + 1);
    assert.equal(requests[0].signal.aborted, true);
    buffer.invalidateAll(revision);
    assert.deepEqual(buffer.freshCoverageGaps(source.length), [{ start: 0, end: source.length }]);
    release();
    assert.equal(await pending, undefined);

    // A semantic policy change invalidates all target ownership, but never
    // widens individual provider requests beyond the configured chunk size.
    while (buffer.freshCoverageGaps(source.length).length > 0) {
        const gap = buffer.freshCoverageGaps(source.length)[0];
        const chunk = selectCoverageRequirement(source, gap, 1, 8);
        const required = stabilizeProjectionRequirement(
            source,
            chunk,
            buffer.segments.map((s) => s.source),
        );
        assert.ok(required);
        session.requireProjectionRange(required);
        const accepted = await session.refresh(document(source), provider);
        assert.ok(accepted);
        assert.equal(accepted.revision, revision);
        assert.equal(requests.at(-1).policy.choices.linq, 'eager');
        assert.ok(requests.at(-1).focusRegion.length <= 8);
        buffer.applyProjection(accepted.sourceOffsets, accepted.text, accepted.revision);
    }
    assert.equal(buffer.hasStaleSegments, false);
    assert.equal(buffer.freshCoverageGaps(source.length).length, 0);
    assert.ok(buffer.text.includes('new:'));
    assert.ok(!buffer.text.includes('old-'));

    assert.throws(
        () => session.reconfigure(revised, { id: 'bad', targetLanguage: 'rust', facilities: [] }),
        /Harness target language/,
    );
    console.log('policy reconfiguration smoke: PASS');
}

function document(text) {
    return { uri: 'memory:///source.cs', languageId: 'csharp', text, version: 1 };
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
