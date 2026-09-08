'use strict';

const assert = require('node:assert/strict');
const {
    ProjectionSession,
    changedOffsetsAfterEdits,
    rebaseOffsetRange,
    selectBoundedSlice,
} = require('../.core-test/core');

async function main() {
    testBoundedSlice();
    testOffsetRebasingHelpers();
    testSameStartChangesAreOrderIndependent();
    await testBoundedPriorContext();
    await testDeferredEditsRebaseAcrossRevisions();
    await testMultipleChangesInOneRevision();
    await testDeletionKeepsUsefulContext();
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

function testOffsetRebasingHelpers() {
    const insertAtStart = change(0, 0, 'header\n');
    assert.deepEqual(
        rebaseOffsetRange({ start: 17, end: 23 }, [insertAtStart]),
        { start: 24, end: 30 },
    );

    const unordered = [
        change(13, 5, 'THREE!!'),
        change(5, 3, 'ONE!'),
    ];
    assert.deepEqual(changedOffsetsAfterEdits(unordered), { start: 5, end: 21 });
}

function testSameStartChangesAreOrderIndependent() {
    const replacement = change(5, 3, 'XYZ');
    const insertion = change(5, 0, '!');

    assert.deepEqual(
        changedOffsetsAfterEdits([replacement, insertion]),
        { start: 5, end: 9 },
    );
    assert.deepEqual(
        changedOffsetsAfterEdits([insertion, replacement]),
        { start: 5, end: 9 },
    );
}

async function testBoundedPriorContext() {
    const session = new ProjectionSession({
        sourceLanguage: 'csharp',
        targetLanguage: 'python',
        contextLines: 0,
        policy: { id: 'default', choices: {} },
        harness: { id: 'none', targetLanguage: 'python', facilities: [] },
    });

    const requests = [];
    const provider = captureProvider(requests);
    const base = ['secret-before', 'also-private', 'value = 0', 'private-after'].join('\n');
    const valueOffset = base.indexOf('value = 0');
    const firstChange = change(valueOffset, 'value = 0'.length, 'value = 1');
    const firstDocumentText = applyChanges(base, [firstChange]);

    session.invalidate([firstChange]);
    await session.refresh(document(1, firstDocumentText), provider);

    const secondChange = change(valueOffset, 'value = 1'.length, 'value = 2');
    const secondDocumentText = applyChanges(firstDocumentText, [secondChange]);
    session.invalidate([secondChange]);
    await session.refresh(document(2, secondDocumentText), provider);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].sourceRegion, 'value = 1');
    assert.equal(requests[0].previousSourceRegion, undefined);
    assert.equal(requests[1].sourceRegion, 'value = 2');
    assert.equal(requests[1].previousSourceRegion, 'value = 1');
    assert.deepEqual(requests[1].previousSourceRange, {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 9 },
    });
    assert.equal(requests[1].previousSourceRegion.includes('secret-before'), false);
    assert.equal(requests[1].previousSourceRegion.includes('private-after'), false);
}

async function testDeferredEditsRebaseAcrossRevisions() {
    const session = new ProjectionSession({
        sourceLanguage: 'csharp',
        targetLanguage: 'python',
        contextLines: 0,
        policy: { id: 'default', choices: {} },
        harness: { id: 'none', targetLanguage: 'python', facilities: [] },
    });

    const requests = [];
    const provider = captureProvider(requests);
    const base = ['alpha', 'beta', 'gamma', 'delta', 'omega'].join('\n');

    const lowerEdit = change(base.indexOf('delta'), 'delta'.length, 'DELTA!');
    const afterLowerEdit = applyChanges(base, [lowerEdit]);
    session.invalidate([lowerEdit]);

    const insertAbove = change(0, 0, 'header\n');
    const finalText = applyChanges(afterLowerEdit, [insertAbove]);
    session.invalidate([insertAbove]);

    await session.refresh(document(2, finalText), provider);

    assert.equal(requests.length, 1);
    assert.equal(
        requests[0].sourceRegion,
        ['header', 'alpha', 'beta', 'gamma', 'DELTA!'].join('\n'),
    );
    assert.deepEqual(requests[0].sourceRange, {
        start: { line: 0, character: 0 },
        end: { line: 4, character: 6 },
    });
}

async function testMultipleChangesInOneRevision() {
    const session = new ProjectionSession({
        sourceLanguage: 'csharp',
        targetLanguage: 'python',
        contextLines: 0,
        policy: { id: 'default', choices: {} },
        harness: { id: 'none', targetLanguage: 'python', facilities: [] },
    });

    const requests = [];
    const provider = captureProvider(requests);
    const base = ['zero', 'one', 'two', 'three', 'four'].join('\n');
    const changes = [
        change(base.indexOf('three'), 'three'.length, 'THREE!!'),
        change(base.indexOf('one'), 'one'.length, 'ONE!'),
    ];
    const finalText = applyChanges(base, changes);

    session.invalidate(changes);
    await session.refresh(document(1, finalText), provider);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].sourceRegion, ['ONE!', 'two', 'THREE!!'].join('\n'));
    assert.deepEqual(requests[0].sourceRange, {
        start: { line: 1, character: 0 },
        end: { line: 3, character: 7 },
    });
}

async function testDeletionKeepsUsefulContext() {
    const session = new ProjectionSession({
        sourceLanguage: 'csharp',
        targetLanguage: 'python',
        contextLines: 1,
        policy: { id: 'default', choices: {} },
        harness: { id: 'none', targetLanguage: 'python', facilities: [] },
    });

    const requests = [];
    const provider = captureProvider(requests);
    const base = ['before', 'delete-me', 'after'].join('\n');
    const deletion = change(base.indexOf('delete-me'), 'delete-me'.length, '');
    const finalText = applyChanges(base, [deletion]);

    session.invalidate([deletion]);
    await session.refresh(document(1, finalText), provider);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].sourceRegion, ['before', '', 'after'].join('\n'));
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

    const base = 'class C {\n    int X = 0;\n}';
    const valueOffset = base.indexOf('0');
    const firstChange = change(valueOffset, 1, '1');
    const firstDocumentText = applyChanges(base, [firstChange]);

    session.invalidate([firstChange]);
    const stalePromise = session.refresh(document(1, firstDocumentText), provider);

    const secondChange = change(firstDocumentText.indexOf('1'), 1, '2');
    const secondDocumentText = applyChanges(firstDocumentText, [secondChange]);
    session.invalidate([secondChange]);
    const current = await session.refresh(document(2, secondDocumentText), provider);

    assert.ok(current);
    assert.equal(current.text, 'current projection');
    assert.equal(current.revision, session.currentRevision);

    assert.equal(typeof releaseFirst, 'function');
    releaseFirst();
    const stale = await stalePromise;
    assert.equal(stale, undefined);
}

function captureProvider(requests) {
    return {
        id: 'capture',
        project(request) {
            requests.push(request);
            return Promise.resolve({
                revision: request.revision,
                text: `projection:${request.sourceRegion}`,
            });
        },
    };
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
