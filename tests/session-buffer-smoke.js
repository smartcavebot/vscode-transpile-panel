'use strict';

const assert = require('node:assert/strict');
const {
    ProjectionSession,
    TargetProjectionBuffer,
    offsetRangeToTextRange,
    selectBoundedContext,
    selectCoverageRequirement,
    stabilizeProjectionRequirement,
    textRangeToOffsetRange,
} = require('../.core-test/core');

async function main() {
    testCrLfRangeConversion();
    testContextOverlapDoesNotBecomeOwnership();
    await testSessionCommitDrivesProjectionBuffer();
    await testBoundedCoverageFocusDoesNotGrow();
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

function testContextOverlapDoesNotBecomeOwnership() {
    const lines = Array.from({ length: 60 }, (_, index) => `line-${index}`);
    const text = lines.join('\n');
    const ownedA = lineRange(text, lines, 0, 24);
    const ownedB = lineRange(text, lines, 30, 40);
    const dirty = textRangeToOffsetRange(text, {
        start: { line: 20, character: 2 },
        end: { line: 20, character: 3 },
    });

    // The exact focus is inside A, so ownership must absorb A only.
    const required = stabilizeProjectionRequirement(
        text,
        dirty,
        [ownedA, ownedB],
    );
    assert.deepEqual(required, ownedA);

    // Provider context around that exact ownership may legitimately cut through B.
    // Context is advisory; it must not force B into target ownership.
    const contextOffsets = textRangeToOffsetRange(
        text,
        selectBoundedContext(text, required, 12, 10000).range,
    );
    assert.ok(contextOffsets.start <= ownedA.start);
    assert.ok(contextOffsets.end > ownedB.start && contextOffsets.end < ownedB.end);
    assert.ok(required.end < ownedB.start);

    // If the focus itself cuts both segments, stabilization still absorbs both.
    const crossingFocus = {
        start: ownedA.end - 2,
        end: ownedB.start + 2,
    };
    assert.deepEqual(
        stabilizeProjectionRequirement(text, crossingFocus, [ownedA, ownedB]),
        { start: ownedA.start, end: ownedB.end },
    );
}

async function testSessionCommitDrivesProjectionBuffer() {
    const session = new ProjectionSession({
        sourceLanguage: 'csharp',
        targetLanguage: 'python',
        contextLines: 1,
        maxContextCharacters: 1000,
        policy: { id: 'default', choices: {} },
        harness: { id: 'none', targetLanguage: 'python', facilities: [] },
    });
    const buffer = new TargetProjectionBuffer(0);
    const requests = [];
    const provider = {
        id: 'session-buffer-smoke',
        project(request) {
            requests.push(request);
            return Promise.resolve({
                revision: request.revision,
                text: `py:${request.focusRegion}`,
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
    assert.equal(requests[0].sourceRegion, source1);
    assert.equal(requests[0].focusRegion, '1');
    assert.deepEqual(firstCommit.sourceRange, {
        start: { line: 1, character: 8 },
        end: { line: 1, character: 9 },
    });
    assert.deepEqual(firstCommit.sourceOffsets, { start: 15, end: 16 });
    assert.equal(firstCommit.text, 'py:1');

    buffer.applyProjection(
        firstCommit.sourceOffsets,
        firstCommit.text,
        firstCommit.revision,
    );
    assert.equal(buffer.text, 'py:1');
    assert.equal(buffer.hasStaleSegments, false);

    const secondEdit = change(source1.indexOf('1'), 1, '2');
    const source2 = applyChanges(source1, [secondEdit]);
    session.invalidate([secondEdit]);
    buffer.rebase([secondEdit], 2);

    assert.equal(buffer.hasStaleSegments, true);

    const secondCommit = await session.refresh(document(2, source2), provider);
    assert.ok(secondCommit);
    assert.equal(requests[1].sourceRegion, source2);
    assert.equal(requests[1].focusRegion, '2');
    assert.deepEqual(secondCommit.sourceOffsets, { start: 15, end: 16 });
    assert.equal(secondCommit.text, 'py:2');

    buffer.applyProjection(
        secondCommit.sourceOffsets,
        secondCommit.text,
        secondCommit.revision,
    );
    assert.equal(buffer.text, 'py:2');
    assert.equal(buffer.hasStaleSegments, false);
    assert.deepEqual(buffer.freshCoverageGaps(source2.length), [
        { start: 0, end: 15 },
        { start: 16, end: source2.length },
    ]);
}

async function testBoundedCoverageFocusDoesNotGrow() {
    const source = 'x'.repeat(13000);
    const session = new ProjectionSession({
        sourceLanguage: 'csharp',
        targetLanguage: 'python',
        contextLines: 80,
        maxContextCharacters: 7000,
        policy: { id: 'default', choices: {} },
        harness: { id: 'none', targetLanguage: 'python', facilities: [] },
    });
    const buffer = new TargetProjectionBuffer(0);
    const requests = [];
    const provider = {
        id: 'bounded-coverage-smoke',
        project(request) {
            requests.push(request);
            return Promise.resolve({
                revision: request.revision,
                text: request.focusRegion,
            });
        },
    };

    const revision = session.invalidate();
    buffer.rebase([], revision);

    while (true) {
        const gap = buffer.coverageGaps(source.length)[0];
        if (!gap) {
            break;
        }

        const selected = selectCoverageRequirement(source, gap, 80, 4000);
        const required = stabilizeProjectionRequirement(
            source,
            selected,
            buffer.segments.map((segment) => segment.source),
        );
        assert.ok(required);
        session.requireProjectionRange(required);

        const commit = await session.refresh(document(revision, source), provider);
        assert.ok(commit);
        buffer.applyProjection(commit.sourceOffsets, commit.text, commit.revision);
    }

    assert.deepEqual(
        buffer.segments.map((segment) => segment.source),
        [
            { start: 0, end: 4000 },
            { start: 4000, end: 8000 },
            { start: 8000, end: 12000 },
            { start: 12000, end: 13000 },
        ],
    );
    assert.equal(buffer.text, source);
    assert.equal(requests.length, 4);
    assert.ok(requests.every((request) => request.focusRegion.length <= 4000));
    assert.ok(requests.every((request) => request.sourceRegion.length <= 7000));
    assert.ok(requests.every((request) => request.sourceRegion.length < source.length));
    assert.ok(
        requests[1].sourceRegion.length > requests[1].focusRegion.length,
        'provider context should be allowed to overlap prior ownership without enlarging focus',
    );
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
