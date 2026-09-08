'use strict';

const assert = require('node:assert/strict');
const {
    ProjectionRefreshScheduler,
    ProjectionSession,
} = require('../.core-test/core');

async function main() {
    await testManualMode();
    await testDebouncedModeUsesLatestSnapshot();
    await testSemanticMode();
    await testModeChangeCancelsPendingDebounce();
    await testDisposeCancelsInFlightProjection();
    testDisposeIsTerminal();
    console.log('scheduler smoke: PASS');
}

async function testManualMode() {
    const requests = [];
    const results = [];
    const session = makeSession();
    const scheduler = new ProjectionRefreshScheduler(
        session,
        captureProvider(requests),
        {
            mode: 'manual',
            debounceMs: 10,
            onResult: (result) => results.push(result),
        },
    );

    const base = 'value = 0';
    const edit = change(base.indexOf('0'), 1, '1');
    const next = applyChanges(base, [edit]);

    scheduler.onDocumentChanged(document(1, next), [edit]);
    assert.equal(requests.length, 0);

    const result = await scheduler.refreshNow();
    assert.ok(result);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].sourceRegion, 'value = 1');
    assert.equal(requests[0].focusRegion, '1');
    assert.equal(results.length, 1);
}

async function testDebouncedModeUsesLatestSnapshot() {
    const requests = [];
    const clock = fakeClock();
    const session = makeSession();
    const scheduler = new ProjectionRefreshScheduler(
        session,
        captureProvider(requests),
        {
            mode: 'debounced',
            debounceMs: 25,
            clock,
        },
    );

    const base = 'value = 0';
    const first = change(base.indexOf('0'), 1, '1');
    const afterFirst = applyChanges(base, [first]);
    scheduler.onDocumentChanged(document(1, afterFirst), [first]);

    assert.equal(clock.pendingCount(), 1);
    assert.equal(requests.length, 0);

    const second = change(afterFirst.indexOf('1'), 1, '2');
    const afterSecond = applyChanges(afterFirst, [second]);
    scheduler.onDocumentChanged(document(2, afterSecond), [second]);

    assert.equal(clock.pendingCount(), 1);
    assert.equal(requests.length, 0);

    clock.fireAll();
    await flushPromises();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].sourceRegion, 'value = 2');
    assert.equal(requests[0].focusRegion, '2');
    assert.equal(requests[0].revision, session.currentRevision);
    assert.equal(scheduler.hasPendingRefresh, false);
}

async function testSemanticMode() {
    const requests = [];
    const session = makeSession();
    const scheduler = new ProjectionRefreshScheduler(
        session,
        captureProvider(requests),
        {
            mode: 'semantic',
            debounceMs: 10,
        },
    );

    const base = 'value = 0';
    const edit = change(base.indexOf('0'), 1, '1');
    const next = applyChanges(base, [edit]);
    scheduler.onDocumentChanged(document(1, next), [edit]);

    assert.equal(requests.length, 0);
    const result = await scheduler.onSemanticEvent();
    assert.ok(result);
    assert.equal(requests.length, 1);

    scheduler.setMode('manual');
    const ignored = await scheduler.onSemanticEvent();
    assert.equal(ignored, undefined);
    assert.equal(requests.length, 1);
}

async function testModeChangeCancelsPendingDebounce() {
    const requests = [];
    const clock = fakeClock();
    const session = makeSession();
    const scheduler = new ProjectionRefreshScheduler(
        session,
        captureProvider(requests),
        {
            mode: 'debounced',
            debounceMs: 25,
            clock,
        },
    );

    const base = 'value = 0';
    const edit = change(base.indexOf('0'), 1, '1');
    scheduler.onDocumentChanged(
        document(1, applyChanges(base, [edit])),
        [edit],
    );

    assert.equal(clock.pendingCount(), 1);
    scheduler.setMode('manual');
    assert.equal(clock.pendingCount(), 0);
    assert.equal(scheduler.hasPendingRefresh, false);

    clock.fireAll();
    await flushPromises();
    assert.equal(requests.length, 0);

    await scheduler.refreshNow();
    assert.equal(requests.length, 1);
}

async function testDisposeCancelsInFlightProjection() {
    let release;
    let signal;
    const results = [];
    const session = makeSession();
    const provider = {
        id: 'blocking-provider',
        project(request) {
            signal = request.signal;
            return new Promise((resolve) => {
                release = () => resolve({
                    revision: request.revision,
                    text: 'must-not-publish',
                });
            });
        },
    };
    const scheduler = new ProjectionRefreshScheduler(session, provider, {
        mode: 'manual',
        debounceMs: 10,
        onResult: (result) => results.push(result),
    });

    const base = 'value = 0';
    const edit = change(base.indexOf('0'), 1, '1');
    const next = applyChanges(base, [edit]);
    scheduler.onDocumentChanged(document(1, next), [edit]);
    const pending = scheduler.refreshNow();

    assert.ok(signal, 'a real dirty focus must start provider work');
    assert.equal(signal.aborted, false);
    scheduler.dispose();
    assert.equal(signal.aborted, true);

    release();
    const result = await pending;
    assert.equal(result, undefined);
    assert.equal(results.length, 0);
}

function testDisposeIsTerminal() {
    const clock = fakeClock();
    const session = makeSession();
    const scheduler = new ProjectionRefreshScheduler(
        session,
        captureProvider([]),
        {
            mode: 'debounced',
            debounceMs: 25,
            clock,
        },
    );

    const base = 'value = 0';
    const edit = change(base.indexOf('0'), 1, '1');
    scheduler.onDocumentChanged(
        document(1, applyChanges(base, [edit])),
        [edit],
    );
    assert.equal(clock.pendingCount(), 1);

    scheduler.dispose();
    assert.equal(clock.pendingCount(), 0);
    assert.throws(
        () => scheduler.onDocumentChanged(document(2, 'value = 2'), []),
        /disposed/,
    );
}

function makeSession() {
    return new ProjectionSession({
        sourceLanguage: 'csharp',
        targetLanguage: 'python',
        contextLines: 0,
        policy: { id: 'default', choices: {} },
        harness: { id: 'none', targetLanguage: 'python', facilities: [] },
    });
}

function captureProvider(requests) {
    return {
        id: 'scheduler-smoke',
        project(request) {
            requests.push(request);
            return Promise.resolve({
                revision: request.revision,
                text: `projection:${request.focusRegion}`,
            });
        },
    };
}

function fakeClock() {
    let nextId = 1;
    const pending = new Map();

    return {
        set(_delayMs, callback) {
            const id = nextId++;
            pending.set(id, callback);
            return id;
        },
        clear(handle) {
            pending.delete(handle);
        },
        pendingCount() {
            return pending.size;
        },
        fireAll() {
            const callbacks = [...pending.values()];
            pending.clear();
            for (const callback of callbacks) {
                callback();
            }
        },
    };
}

function document(version, text) {
    return {
        uri: 'memory:///scheduler.cs',
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

async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
