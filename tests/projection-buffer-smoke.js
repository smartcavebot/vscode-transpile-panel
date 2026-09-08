'use strict';

const assert = require('node:assert/strict');
const { TargetProjectionBuffer } = require('../.core-test/core');

function main() {
    testExactConcatenationAndCoverageGaps();
    testWholeSegmentReplacement();
    testPartialReplacementRejected();
    testEditBeforeSegmentRebasesWithoutStaling();
    testInsertionAtSegmentStartBelongsToSegment();
    testInsertionAtSegmentEndDoesNotBelongToSegment();
    testFullDeletionRemovesTargetSegment();
    testFullReplacementKeepsStaleOwnership();
    testDeletionDropsOnlyVanishedOwnership();
    testCrossBoundaryReplacementCoalescesStaleOwnership();
    testOldRevisionCannotPublish();
    testFreshCoverageExcludesStaleSegments();
    testZeroWidthOwnershipRejected();
    console.log('projection buffer smoke: PASS');
}

function testExactConcatenationAndCoverageGaps() {
    const buffer = new TargetProjectionBuffer(0);
    buffer.applyProjection({ start: 0, end: 5 }, 'alpha');
    buffer.applyProjection({ start: 10, end: 20 }, 'beta');

    assert.equal(buffer.text, 'alphabeta');
    assert.deepEqual(buffer.coverageGaps(25), [
        { start: 5, end: 10 },
        { start: 20, end: 25 },
    ]);
}

function testWholeSegmentReplacement() {
    const buffer = new TargetProjectionBuffer(0);
    buffer.applyProjection({ start: 0, end: 5 }, 'A');
    buffer.applyProjection({ start: 5, end: 10 }, 'B');
    buffer.applyProjection({ start: 0, end: 10 }, 'AB2');

    assert.equal(buffer.text, 'AB2');
    assert.deepEqual(buffer.segments, [
        { source: { start: 0, end: 10 }, text: 'AB2', stale: false },
    ]);
}

function testPartialReplacementRejected() {
    const buffer = new TargetProjectionBuffer(0);
    buffer.applyProjection({ start: 0, end: 10 }, 'whole');

    assert.throws(
        () => buffer.applyProjection({ start: 5, end: 10 }, 'partial'),
        /partially overlaps/,
    );
    assert.equal(buffer.text, 'whole');
}

function testEditBeforeSegmentRebasesWithoutStaling() {
    const buffer = new TargetProjectionBuffer(0);
    buffer.applyProjection({ start: 5, end: 10 }, 'segment');

    buffer.rebase([change(2, 0, 'xx')], 1);

    assert.deepEqual(buffer.segments, [
        { source: { start: 7, end: 12 }, text: 'segment', stale: false },
    ]);
}

function testInsertionAtSegmentStartBelongsToSegment() {
    const buffer = new TargetProjectionBuffer(0);
    buffer.applyProjection({ start: 5, end: 10 }, 'segment');

    buffer.rebase([change(5, 0, 'xx')], 1);

    assert.deepEqual(buffer.segments, [
        { source: { start: 5, end: 12 }, text: 'segment', stale: true },
    ]);
}

function testInsertionAtSegmentEndDoesNotBelongToSegment() {
    const buffer = new TargetProjectionBuffer(0);
    buffer.applyProjection({ start: 5, end: 10 }, 'segment');

    buffer.rebase([change(10, 0, 'xx')], 1);

    assert.deepEqual(buffer.segments, [
        { source: { start: 5, end: 10 }, text: 'segment', stale: false },
    ]);
}

function testFullDeletionRemovesTargetSegment() {
    const buffer = new TargetProjectionBuffer(0);
    buffer.applyProjection({ start: 5, end: 10 }, 'obsolete-target');

    buffer.rebase([change(5, 5, '')], 1);

    assert.equal(buffer.text, '');
    assert.deepEqual(buffer.segments, []);
    assert.equal(buffer.hasStaleSegments, false);
    assert.deepEqual(buffer.staleRanges(), []);
}

function testFullReplacementKeepsStaleOwnership() {
    const buffer = new TargetProjectionBuffer(0);
    buffer.applyProjection({ start: 5, end: 10 }, 'old-target');

    buffer.rebase([change(5, 5, 'xx')], 1);

    assert.equal(buffer.text, 'old-target');
    assert.deepEqual(buffer.segments, [
        { source: { start: 5, end: 7 }, text: 'old-target', stale: true },
    ]);
}

function testDeletionDropsOnlyVanishedOwnership() {
    const buffer = new TargetProjectionBuffer(0);
    buffer.applyProjection({ start: 0, end: 5 }, 'A');
    buffer.applyProjection({ start: 5, end: 10 }, 'B');

    buffer.rebase([change(0, 5, '')], 1);

    assert.equal(buffer.text, 'B');
    assert.deepEqual(buffer.segments, [
        { source: { start: 0, end: 5 }, text: 'B', stale: false },
    ]);
}

function testCrossBoundaryReplacementCoalescesStaleOwnership() {
    const buffer = new TargetProjectionBuffer(0);
    buffer.applyProjection({ start: 0, end: 5 }, 'A');
    buffer.applyProjection({ start: 10, end: 15 }, 'B');

    buffer.rebase([change(4, 7, 'XX')], 1);

    assert.equal(buffer.text, 'AB');
    assert.deepEqual(buffer.segments, [
        { source: { start: 0, end: 10 }, text: 'AB', stale: true },
    ]);
    assert.deepEqual(buffer.staleRanges(), [{ start: 0, end: 10 }]);
}

function testOldRevisionCannotPublish() {
    const buffer = new TargetProjectionBuffer(0);
    buffer.rebase([change(0, 0, 'x')], 1);

    assert.throws(
        () => buffer.applyProjection({ start: 0, end: 1 }, 'old', 0),
        /does not match current source revision/,
    );
    buffer.applyProjection({ start: 0, end: 1 }, 'current', 1);
    assert.equal(buffer.text, 'current');
}

function testFreshCoverageExcludesStaleSegments() {
    const buffer = new TargetProjectionBuffer(0);
    buffer.applyProjection({ start: 0, end: 5 }, 'A');
    buffer.applyProjection({ start: 5, end: 10 }, 'B');

    buffer.rebase([change(1, 1, 'z')], 1);

    assert.deepEqual(buffer.coverageGaps(10), []);
    assert.deepEqual(buffer.freshCoverageGaps(10), [{ start: 0, end: 5 }]);
}

function testZeroWidthOwnershipRejected() {
    const buffer = new TargetProjectionBuffer(0);
    assert.throws(
        () => buffer.applyProjection({ start: 3, end: 3 }, 'generated'),
        /non-empty half-open range/,
    );
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

main();
