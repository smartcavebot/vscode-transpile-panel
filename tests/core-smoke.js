'use strict';

const assert = require('node:assert/strict');
const {
    ProjectionSession,
    selectBoundedSlice,
} = require('../.core-test/core');

async function main() {
    testBoundedSlice();
    await testLatestWins();
    console.log('core smoke: PASS');
}

function testBoundedSlice() {
    const text = ['zero', 'one', 'two', 'three', 'four', 'five'].join('\n');
    const slice = selectBoundedSlice(
        text,
        {
            start: { line: 3, character: 1 },
            end: { line: 3, character: 4 },
        },
        1,
    );

    assert.equal(slice.text, ['two', 'three', 'four'].join('\n'));
    assert.deepEqual(slice.range, {
        start: { line: 2, character: 0 },
        end: { line: 4, character: 4 },
    });
}

async function testLatestWins() {
    const session = new ProjectionSession({
        sourceLanguage: 'csharp',
        targetLanguage: 'python',
        contextLines: 1,
        policy: { id: 'default', choices: {} },
        harness: { id: 'none', targetLanguage: 'python', facilities: [] },
    });

    let releaseFirst;
    let callCount = 0;

    const provider = {
        id: 'headless-smoke',
        project(request) {
            callCount += 1;
            if (callCount === 1) {
                return new Promise((resolve) => {
                    releaseFirst = () => resolve({
                        revision: request.revision,
                        text: 'stale projection',
                    });
                });
            }

            return Promise.resolve({
                revision: request.revision,
                text: 'current projection',
            });
        },
    };

    const firstDocument = {
        uri: 'memory:///sample.cs',
        languageId: 'csharp',
        version: 1,
        text: 'class C {\n    int X = 1;\n}',
    };

    session.invalidate({
        start: { line: 1, character: 4 },
        end: { line: 1, character: 13 },
    });
    const stalePromise = session.refresh(firstDocument, provider);

    const secondDocument = {
        ...firstDocument,
        version: 2,
        text: 'class C {\n    int X = 2;\n}',
    };

    session.invalidate({
        start: { line: 1, character: 12 },
        end: { line: 1, character: 13 },
    });
    const current = await session.refresh(secondDocument, provider);

    assert.ok(current);
    assert.equal(current.text, 'current projection');
    assert.equal(current.revision, session.currentRevision);

    assert.equal(typeof releaseFirst, 'function');
    releaseFirst();
    const stale = await stalePromise;
    assert.equal(stale, undefined);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
