'use strict';

const assert = require('node:assert/strict');
const {
    ProjectionSession,
    TargetProjectionBuffer,
    textRangeToOffsetRange,
} = require('../.core-test/core');

async function main() {
    testCrLfRangeConversion();
    await testSessionCommitDrivesProjectionBuffer();
    console.log('session buffer smoke: PASS');
}

function testCrLfRangeConversion() {
    const text = 'first\r\nvalue = 0\r\nlast';
    assert.deepEqual(
        textRangeToOffsetRange(text, {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 9 },
        }),
        { start: 7, end: 16 },
    );

    assert.throws(
        () => textRangeToOffsetRange(text, {
            start: { line: 1, character: 10 },
            end: { line: 1, character: 10 },
        }),
        /exceeds line 1 length 9/,
    );
}

async function testSessionCommitDrivesProjectionBuffer() {
    const session = new ProjectionSession({
        sourceLanguage: 'csharp',
        targetLanguage: 'python',
        contextLines: 0,
        policy: { id: 'default', choices: {} },
        harness: { id: 'none', targetLanguage: 'python', facilities: [] },
    });
    const buffer = new TargetProjectionBuffer(0);
    const provider = {
        id: 'session-buffer-smoke',
        project(request) {
            return Promise.resolve({
                revision: request.revision,
                text: `py:${request.sourceRegion}`,
            });
        },
    };

    const source0 = 'first\r\nvalue = 0\r\nlast';
    const firstEdit = change(source0.indexOf('0'), 1, '1');
    const source1 = applyChanges(source0, [firstEdit]);

    session.invalidate([firstEdit]);
    buffer.rebase([firstEdit], 1);
    const firstCommit = await session.refresh(document(1, source1), provider);

    assert.ok(firstCommit);
    assert.deepEqual(firstCommit.sourceRange, {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 9 },
    });
    assert.deepEqual(firstCommit.sourceOffsets, { start: 7, end: 16 });
    assert.equal(firstCommit.text, 'py:value = 1');

    buffer.applyProjection(
        firstCommit.sourceOffsets,
        firstCommit.text,
        firstCommit.revision,
    );
    assert.equal(buffer.text, 'py:value = 1');
    assert.equal(buffer.hasStaleSegments, false);

    const secondEdit = change(source1.indexOf('1'), 1, '2');
    const source2 = applyChanges(source1, [secondEdit]);
    session.invalidate([secondEdit]);
    buffer.rebase([secondEdit], 2);

    assert.equal(buffer.hasStaleSegments, true);

    const secondCommit = await session.refresh(document(2, source2), provider);
    assert.ok(secondCommit);
    assert.deepEqual(secondCommit.sourceOffsets, { start: 7, end: 16 });
    assert.equal(secondCommit.text, 'py:value = 2');

    buffer.applyProjection(
        secondCommit.sourceOffsets,
        secondCommit.text,
        secondCommit.revision,
    );
    assert.equal(buffer.text, 'py:value = 2');
    assert.equal(buffer.hasStaleSegments, false);
    assert.deepEqual(buffer.freshCoverageGaps(source2.length), [
        { start: 0, end: 7 },
        { start: 16, end: source2.length },
    ]);
}

function document(version, text) {
    return {
        uri: 'memory:///sample.cs',
        languageId: 'csharp',
        version,
        text,
    };
}

function change(rangeOffset, rangeLength, text) {
    return {
        range: {
            start: { line: 0, character: rangeOffset },
            end: { line: 0, character: rangeOffset + rangeLength },
        },
        rangeOffset,
        rangeLength,
        text,
    };
}

function applyChanges(source, changes) {
    return [...changes]
        .sort((a, b) => b.rangeOffset - a.rangeOffset)
        .reduce(
            (text, item) =>
                text.slice(0, item.rangeOffset) +
                item.text +
                text.slice(item.rangeOffset + item.rangeLength),
            source,
        );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
