'use strict';

const assert = require('node:assert/strict');
const {
    ProjectionSession,
    TargetProjectionBuffer,
    offsetRangeToTextRange,
    selectBoundedSlice,
    stabilizeProjectionRequirement,
    textRangeToOffsetRange,
} = require('../.core-test/core');

async function main() {
    testCrLfRangeConversion();
    testReplacementRequirementAbsorbsPartialSegments();
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

function testReplacementRequirementAbsorbsPartialSegments() {
    const lines = Array.from({ length: 60 }, (_, index) => `line-${index}`);
    const text = lines.join('\n');
    const ownedA = lineRange(text, lines, 0, 24);
    const ownedB = lineRange(text, lines, 30, 40);
    const dirty = textRangeToOffsetRange(text, {
        start: { line: 20, character: 2 },
        end: { line: 20, character: 3 },
    });

    // The raw dirty slice with 12 lines of context is lines 8..32. It cuts through
    // both existing ownership ranges, so publishing it would be a forbidden partial
    // target-segment replacement.
    const rawPlanned = textRangeToOffsetRange(
        text,
        selectBoundedSlice(text, offsetRangeToTextRange(text, dirty), 12).range,
    );
    assert.ok(rawPlanned.start > ownedA.start && rawPlanned.start < ownedA.end);
    assert.ok(rawPlanned.end > ownedB.start && rawPlanned.end < ownedB.end);

    const required = stabilizeProjectionRequirement(
        text,
        dirty,
        12,
        [ownedA, ownedB],
    );

    assert.deepEqual(required, {
        start: ownedA.start,
        end: ownedB.end,
    });

    const stabilizedPlanned = textRangeToOffsetRange(
        text,
        selectBoundedSlice(
            text,
            offsetRangeToTextRange(text, required),
            12,
        ).range,
    );

    assert.ok(stabilizedPlanned.start <= ownedA.start);
    assert.ok(stabilizedPlanned.end >= ownedA.end);
    assert.ok(stabilizedPlanned.start <= ownedB.start);
    assert.ok(stabilizedPlanned.end >= ownedB.end);
    assert.ok(required.end < text.length, 'ownership widening must not become a whole-file fallback');
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

function lineRange(text, lines, startLine, endLine) {
    return textRangeToOffsetRange(text, {
        start: { line: startLine, character: 0 },
        end: { line: endLine, character: lines[endLine].length },
    });
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
