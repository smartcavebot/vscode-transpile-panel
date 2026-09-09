'use strict';

const assert = require('node:assert/strict');
const {
    LiteralBoundaryProjectionProvider,
    ProjectionSession,
    protectCSharpLiterals,
    stabilizeCSharpLiteralFocus,
} = require('../.core-test/core');

async function main() {
    testOrdinaryLiteralLowering();
    testBytesAndInterpolation();
    testPlaceholderCollisionAvoidance();
    testLiteralFocusStabilization();
    testRawStringFocusFailsClosed();
    await testProviderRequestRedaction();
    await testSessionWidensLiteralOwnership();
    await testPreparedContextMasksPartialMultilineLiteral();
    await testUnsupportedPairFailsClosed();
    console.log('literal boundary smoke: PASS');
}

function testOrdinaryLiteralLowering() {
    const source =
        'var s = "sec\\nret"; var ok = true; var n = 12u; var d = 1.25m; var z = null;';
    const boundary = protectCSharpLiterals(source);

    assert(!boundary.protectedText.includes('sec'));
    assert(!boundary.protectedText.includes('1.25'));
    assert.equal(
        boundary.restore(boundary.protectedText),
        'var s = "sec\\nret"; var ok = True; var n = 12; var d = Decimal("1.25"); var z = None;',
    );
}

function testBytesAndInterpolation() {
    const bytes = protectCSharpLiterals(
        'var b = new byte[] { 0x41, 66, 255 }; var u = "é"u8;',
    );
    assert(!bytes.protectedText.includes('0x41'));
    assert(!bytes.protectedText.includes('é'));
    assert.equal(
        bytes.restore(bytes.protectedText),
        'var b = bytes([65, 66, 255]); var u = b"\\xc3\\xa9";',
    );

    const interpolation = protectCSharpLiterals(
        'var s = $"token=abc {user.Id} end";',
    );
    assert(!interpolation.protectedText.includes('token=abc'));
    assert(!interpolation.protectedText.includes(' end'));
    assert(interpolation.protectedText.includes('{user.Id}'));

    const providerShape = interpolation.protectedText.replace('$"', 'f"');
    assert.equal(
        interpolation.restore(providerShape),
        'var s = f"token=abc {user.Id} end";',
    );
}

function testPlaceholderCollisionAvoidance() {
    const source = 'var __TPB0_STRING_0__ = 1; var s = "secret";';
    const boundary = protectCSharpLiterals(source);
    assert(boundary.protectedText.includes('__TPB0_STRING_0__'));
    assert(boundary.protectedText.includes('__TPB1_STRING_'));
    assert.equal(
        boundary.restore(boundary.protectedText),
        'var __TPB0_STRING_0__ = 1; var s = "secret";',
    );
}

function testLiteralFocusStabilization() {
    const text = 'var x = "secret"; var y = 1;';
    const inside = text.indexOf('cret');
    const stabilized = stabilizeCSharpLiteralFocus(text, {
        start: inside,
        end: inside + 2,
    });
    const quote = text.indexOf('"');
    assert.deepEqual(stabilized, {
        start: quote,
        end: text.indexOf('"', quote + 1) + 1,
    });
}

function testRawStringFocusFailsClosed() {
    const text = 'var s = """secret""";';
    const start = text.indexOf('secret');
    assert.throws(
        () => stabilizeCSharpLiteralFocus(text, { start, end: start + 2 }),
        /raw string intersects the projection focus/,
    );
}

async function testProviderRequestRedaction() {
    const requests = [];
    const inner = captureProvider(requests);
    const provider = new LiteralBoundaryProjectionProvider(inner);
    const text = 'var s = "secret"; var ok = true;';

    provider.stabilizeSourceFocus(
        text,
        { start: 0, end: text.length },
        'csharp',
        'python',
    );
    const result = await provider.project({
        sourceLanguage: 'csharp',
        targetLanguage: 'python',
        sourceUri: 'file:///x.cs',
        revision: 1,
        sourceRegion: text,
        sourceRange: textRange(0, 0, 0, text.length),
        focusRegion: text,
        focusRange: textRange(0, 0, 0, text.length),
        previousSourceRegion: 'var old = "older-secret";',
        previousSourceRange: textRange(0, 0, 0, 25),
        previousProjection: 'old = "python-secret"',
        policy: { id: 'default', choices: {} },
        harness: { id: 'none', targetLanguage: 'python', facilities: [] },
        signal: { aborted: false },
    });

    const captured = requests[0];
    for (const secret of ['secret', 'older-secret', 'python-secret']) {
        assert(!captured.sourceRegion.includes(secret));
        assert(!captured.focusRegion.includes(secret));
        assert(!String(captured.previousSourceRegion).includes(secret));
        assert(!String(captured.previousProjection).includes(secret));
    }
    assert.equal(result.text, 'var s = "secret"; var ok = True;');
}

async function testSessionWidensLiteralOwnership() {
    const source = 'var x = "secret";';
    const requests = [];
    const provider = new LiteralBoundaryProjectionProvider(captureProvider(requests));
    const session = sessionFor('csharp', 'python', 0);
    const inside = source.indexOf('cret');
    session.requireProjectionRange({ start: inside, end: inside + 1 });

    const commit = await session.refresh(
        { uri: 'file:///focus.cs', languageId: 'csharp', text: source, version: 1 },
        provider,
    );

    const quote = source.indexOf('"');
    assert.deepEqual(commit.sourceOffsets, {
        start: quote,
        end: source.indexOf('"', quote + 1) + 1,
    });
    assert(!requests[0].focusRegion.includes('secret'));
    assert.equal(commit.text, '"secret"');
}

async function testPreparedContextMasksPartialMultilineLiteral() {
    const source = [
        'var s = @"line-one',
        'line-two',
        'line-three";',
        'var x = 1;',
    ].join('\n');
    const requests = [];
    const provider = new LiteralBoundaryProjectionProvider(captureProvider(requests));
    const session = sessionFor('csharp', 'python', 1);
    const focusStart = source.indexOf('var x');
    session.requireProjectionRange({ start: focusStart, end: source.length });

    await session.refresh(
        { uri: 'file:///context.cs', languageId: 'csharp', text: source, version: 1 },
        provider,
    );

    assert(!requests[0].sourceRegion.includes('line-three'));
    assert(!requests[0].sourceRegion.includes('line-two'));
    assert(requests[0].sourceRegion.includes('var x'));
}

async function testUnsupportedPairFailsClosed() {
    const provider = new LiteralBoundaryProjectionProvider({
        id: 'must-not-run',
        async project() {
            throw new Error('inner provider must not run');
        },
    });

    await assert.rejects(
        () =>
            provider.project({
                sourceLanguage: 'csharp',
                targetLanguage: 'rust',
                sourceUri: 'file:///x.cs',
                revision: 1,
                sourceRegion: '"secret"',
                sourceRange: textRange(0, 0, 0, 8),
                focusRegion: '"secret"',
                focusRange: textRange(0, 0, 0, 8),
                policy: { id: 'default', choices: {} },
                harness: { id: 'none', targetLanguage: 'rust', facilities: [] },
                signal: { aborted: false },
            }),
        /refusing an unprotected provider request/,
    );
}

function captureProvider(requests) {
    return {
        id: 'capture',
        async project(request) {
            requests.push(request);
            return { revision: request.revision, text: request.focusRegion };
        },
    };
}

function sessionFor(sourceLanguage, targetLanguage, contextLines) {
    return new ProjectionSession({
        sourceLanguage,
        targetLanguage,
        contextLines,
        policy: { id: 'default', choices: {} },
        harness: { id: 'none', targetLanguage, facilities: [] },
    });
}

function textRange(startLine, startCharacter, endLine, endCharacter) {
    return {
        start: { line: startLine, character: startCharacter },
        end: { line: endLine, character: endCharacter },
    };
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
