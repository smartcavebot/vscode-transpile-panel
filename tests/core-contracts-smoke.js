'use strict';

const assert = require('node:assert/strict');
const {
    applyGroundedPatch,
    recordProjectionTelemetry,
    runProjectionValidators,
} = require('../.core-test/core');

async function main() {
    testGroundedPatchSequentialApplication();
    testGroundedPatchRejectsStaleAndAmbiguousAnchors();
    await testValidationAggregationAndCancellation();
    await testContentFreeTelemetrySink();
    console.log('core contracts smoke: PASS');
}

function testGroundedPatchSequentialApplication() {
    const result = applyGroundedPatch(
        'value = 1\nname = "x"',
        7,
        {
            revision: 7,
            edits: [
                { search: 'value = 1', replace: 'value = 2' },
                { search: 'name = "x"', replace: 'name = "y"' },
            ],
        },
    );

    assert.equal(result.text, 'value = 2\nname = "y"');
    assert.equal(result.appliedEdits, 2);

    const dependent = applyGroundedPatch(
        'alpha',
        3,
        {
            revision: 3,
            edits: [
                { search: 'alpha', replace: 'alpha beta' },
                { search: 'beta', replace: 'gamma' },
            ],
        },
    );
    assert.equal(dependent.text, 'alpha gamma');
}

function testGroundedPatchRejectsStaleAndAmbiguousAnchors() {
    assert.throws(
        () =>
            applyGroundedPatch('value = 2', 5, {
                revision: 4,
                edits: [{ search: 'value = 1', replace: 'value = 2' }],
            }),
        (error) => error.code === 'revision-mismatch',
    );

    assert.throws(
        () =>
            applyGroundedPatch('value = 2', 5, {
                revision: 5,
                edits: [{ search: 'value = 1', replace: 'value = 3' }],
            }),
        (error) => error.code === 'missing-anchor',
    );

    assert.throws(
        () =>
            applyGroundedPatch('aaa', 5, {
                revision: 5,
                edits: [{ search: 'aa', replace: 'b' }],
            }),
        (error) => error.code === 'ambiguous-anchor',
    );

    assert.throws(
        () =>
            applyGroundedPatch('x', 5, {
                revision: 5,
                edits: [{ search: '', replace: 'y' }],
            }),
        (error) => error.code === 'empty-search',
    );
}

async function testValidationAggregationAndCancellation() {
    const signalState = { aborted: false };
    const request = {
        revision: 4,
        targetLanguage: 'python',
        text: 'print(x)',
        policy: { id: 'default', choices: {} },
        harness: { id: 'none', targetLanguage: 'python', facilities: [] },
        signal: signalState,
    };

    const validators = [
        {
            id: 'syntax',
            async validate() {
                return {
                    validatorId: 'syntax',
                    issues: [
                        {
                            code: 'PY001',
                            message: 'synthetic warning',
                            severity: 'warning',
                            range: { start: 0, end: 5 },
                        },
                    ],
                };
            },
        },
        {
            id: 'semantic',
            async validate() {
                return {
                    validatorId: 'semantic',
                    issues: [
                        {
                            code: 'PY002',
                            message: 'synthetic error',
                            severity: 'error',
                        },
                    ],
                };
            },
        },
    ];

    const result = await runProjectionValidators(validators, request);
    assert.equal(result.cancelled, false);
    assert.equal(result.hasErrors, true);
    assert.deepEqual(
        result.results.map((item) => item.validatorId),
        ['syntax', 'semantic'],
    );

    const cancellation = { aborted: false };
    const seen = [];
    const cancelled = await runProjectionValidators(
        [
            {
                id: 'first',
                async validate() {
                    seen.push('first');
                    cancellation.aborted = true;
                    return { validatorId: 'first', issues: [] };
                },
            },
            {
                id: 'second',
                async validate() {
                    seen.push('second');
                    return { validatorId: 'second', issues: [] };
                },
            },
        ],
        { ...request, signal: cancellation },
    );

    assert.equal(cancelled.cancelled, true);
    assert.deepEqual(seen, ['first']);
    assert.deepEqual(
        cancelled.results.map((item) => item.validatorId),
        ['first'],
    );

    await assert.rejects(
        () =>
            runProjectionValidators(
                [
                    {
                        id: 'bad-range',
                        async validate() {
                            return {
                                validatorId: 'bad-range',
                                issues: [
                                    {
                                        code: 'BAD',
                                        message: 'outside target',
                                        severity: 'error',
                                        range: { start: 0, end: 100 },
                                    },
                                ],
                            };
                        },
                    },
                ],
                request,
            ),
        /invalid target range/,
    );
}

async function testContentFreeTelemetrySink() {
    const events = [];
    await recordProjectionTelemetry(
        {
            record(event) {
                events.push(event);
            },
        },
        {
            kind: 'provider',
            phase: 'result',
            revision: 9,
            sourceLanguage: 'csharp',
            targetLanguage: 'python',
            policyId: 'default',
            harnessId: 'none',
            providerId: 'example',
            sourceCharacters: 80,
            focusCharacters: 12,
            previousProjectionCharacters: 10,
            outputCharacters: 14,
            durationMs: 25,
        },
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'provider');
    assert.equal(Object.prototype.hasOwnProperty.call(events[0], 'text'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(events[0], 'sourceRegion'), false);

    await recordProjectionTelemetry(undefined, {
        kind: 'patch',
        status: 'applied',
        revision: 9,
        sourceLanguage: 'csharp',
        targetLanguage: 'python',
        policyId: 'default',
        harnessId: 'none',
        editCount: 1,
        beforeCharacters: 10,
        afterCharacters: 11,
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
