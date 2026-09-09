import type { OffsetRange } from './changes';
import type { TextPosition, TextRange } from './model';
import type { ProjectionProvider, ProjectionRequest, ProjectionResult } from './provider';

interface Replacement {
    readonly placeholder: string;
    readonly targetText: string;
}

interface ScannedLiteral {
    readonly start: number;
    readonly end: number;
    readonly kind: LiteralKind;
    readonly targetText: string;
    readonly protectedText?: string;
    readonly segmentReplacements?: readonly SegmentReplacement[];
}

interface SegmentReplacement {
    readonly start: number;
    readonly end: number;
    readonly targetText: string;
}

type LiteralKind =
    | 'string'
    | 'number'
    | 'boolean'
    | 'null'
    | 'bytes'
    | 'interpolated'
    | 'unsupported';

type SourceLanguage = 'csharp' | 'python';

/**
 * Host-neutral literal boundary for provider calls.
 *
 * Initial support is deliberately fail-closed to the canonical C# -> Python pair. It removes
 * recognized literal payloads from current source/context and prior source/target fragments, then
 * restores deterministic Python literal syntax after the wrapped provider returns.
 */
export class LiteralBoundaryProjectionProvider implements ProjectionProvider {
    readonly id: string;
    private preparedSource?: { readonly text: string; readonly literals: readonly ScannedLiteral[] };

    constructor(private readonly inner: ProjectionProvider) {
        this.id = `literal-boundary:${inner.id}`;
    }

    stabilizeSourceFocus(
        text: string,
        focus: OffsetRange,
        sourceLanguage: string,
        targetLanguage: string,
    ): OffsetRange {
        assertSupportedPair(sourceLanguage, targetLanguage);
        const literals = scanCSharp(text);
        this.preparedSource = { text, literals };
        let stabilized = stabilizeLiteralFocus(text, focus, literals);
        if (this.inner.stabilizeSourceFocus) {
            stabilized = this.inner.stabilizeSourceFocus(
                text,
                stabilized,
                sourceLanguage,
                targetLanguage,
            );
        }
        return stabilized;
    }

    async project(request: ProjectionRequest): Promise<ProjectionResult> {
        assertSupportedPair(request.sourceLanguage, request.targetLanguage);

        const namespace = chooseNamespace([
            request.sourceRegion,
            request.focusRegion,
            request.previousSourceRegion,
            request.previousProjection,
        ]);
        const replacements = new Map<string, Replacement>();
        let nextPlaceholder = 0;

        const protect = (text: string | undefined, language: SourceLanguage): string | undefined => {
            if (text === undefined) {
                return undefined;
            }
            return protectText(
                text,
                language,
                namespace,
                replacements,
                () => nextPlaceholder++,
            );
        };

        const prepared = this.preparedSource;
        const protectCurrentSource = (text: string, range: TextRange): string => {
            if (!prepared) {
                return protect(text, 'csharp')!;
            }
            const offsets = textRangeToOffsets(prepared.text, range);
            const expected = prepared.text.slice(offsets.start, offsets.end);
            if (expected !== text) {
                throw new Error('Prepared literal-boundary source no longer matches the projection request.');
            }
            return protectPreparedSlice(
                prepared.text,
                offsets,
                prepared.literals,
                namespace,
                replacements,
                () => nextPlaceholder++,
            );
        };

        const protectedRequest: ProjectionRequest = {
            ...request,
            sourceRegion: protectCurrentSource(request.sourceRegion, request.sourceRange),
            focusRegion: protectCurrentSource(request.focusRegion, request.focusRange),
            previousSourceRegion: protect(request.previousSourceRegion, 'csharp'),
            previousProjection: protect(request.previousProjection, 'python'),
        };

        const result = await this.inner.project(protectedRequest);
        return {
            ...result,
            text: restoreProtectedText(result.text, namespace, replacements),
        };
    }
}

/** Expand an incremental focus so it never owns only part of a recognized C# literal. */
export function stabilizeCSharpLiteralFocus(text: string, focus: OffsetRange): OffsetRange {
    return stabilizeLiteralFocus(text, focus, scanCSharp(text));
}

function stabilizeLiteralFocus(
    text: string,
    focus: OffsetRange,
    literals: readonly ScannedLiteral[],
): OffsetRange {
    assertRange(text, focus);
    let result = { start: focus.start, end: focus.end };

    for (let iteration = 0; iteration <= literals.length; iteration += 1) {
        let expanded = false;
        for (const literal of literals) {
            if (rangesOverlap(result, literal) && literal.kind === 'unsupported') {
                throw new Error(
                    'Unsupported C# raw string intersects the projection focus; refusing to expose or mistranslate its payload.',
                );
            }
            if (rangesOverlap(result, literal) && !rangeContains(result, literal)) {
                result = {
                    start: Math.min(result.start, literal.start),
                    end: Math.max(result.end, literal.end),
                };
                expanded = true;
            }
        }
        if (!expanded) {
            return result;
        }
    }

    throw new Error('Literal focus stabilization did not converge.');
}

/** Testable direct boundary helper for the canonical C# -> Python lowering. */
export function protectCSharpLiterals(text: string): {
    readonly protectedText: string;
    readonly restore: (providerText: string) => string;
} {
    const namespace = chooseNamespace([text]);
    const replacements = new Map<string, Replacement>();
    let nextPlaceholder = 0;
    const protectedText = protectText(
        text,
        'csharp',
        namespace,
        replacements,
        () => nextPlaceholder++,
    );
    return {
        protectedText,
        restore: (providerText: string) => restoreProtectedText(providerText, namespace, replacements),
    };
}

function protectText(
    text: string,
    language: SourceLanguage,
    namespace: string,
    replacements: Map<string, Replacement>,
    allocate: () => number,
): string {
    const literals = language === 'csharp' ? scanCSharp(text) : scanPython(text);
    if (literals.length === 0) {
        return text;
    }

    let output = '';
    let cursor = 0;
    for (const literal of literals) {
        if (literal.start < cursor) {
            continue;
        }
        output += text.slice(cursor, literal.start);

        if (literal.kind === 'unsupported') {
            throw new Error(
                'Unsupported literal intersects provider-owned source; refusing an unprotected or semantically incorrect request.',
            );
        }
        if (literal.kind === 'interpolated' && literal.segmentReplacements) {
            let literalCursor = literal.start;
            for (const segment of literal.segmentReplacements) {
                output += text.slice(literalCursor, segment.start);
                const placeholder = createPlaceholder(namespace, 'SEGMENT', allocate());
                replacements.set(placeholder, { placeholder, targetText: segment.targetText });
                output += placeholder;
                literalCursor = segment.end;
            }
            output += text.slice(literalCursor, literal.end);
        } else {
            const placeholder = createPlaceholder(namespace, literal.kind.toUpperCase(), allocate());
            replacements.set(placeholder, { placeholder, targetText: literal.targetText });
            output += placeholder;
        }
        cursor = literal.end;
    }
    output += text.slice(cursor);
    return output;
}

function protectPreparedSlice(
    fullText: string,
    slice: OffsetRange,
    literals: readonly ScannedLiteral[],
    namespace: string,
    replacements: Map<string, Replacement>,
    allocate: () => number,
): string {
    let output = '';
    let cursor = slice.start;
    for (const literal of literals) {
        if (literal.end <= slice.start || literal.start >= slice.end) {
            continue;
        }
        const overlapStart = Math.max(slice.start, literal.start);
        const overlapEnd = Math.min(slice.end, literal.end);
        if (overlapStart < cursor) {
            continue;
        }
        output += fullText.slice(cursor, overlapStart);

        const fullyContained = literal.start >= slice.start && literal.end <= slice.end;
        if (fullyContained && literal.kind === 'interpolated' && literal.segmentReplacements) {
            let literalCursor = literal.start;
            output += fullText.slice(overlapStart, literal.start);
            for (const segment of literal.segmentReplacements) {
                output += fullText.slice(literalCursor, segment.start);
                const placeholder = createPlaceholder(namespace, 'SEGMENT', allocate());
                replacements.set(placeholder, { placeholder, targetText: segment.targetText });
                output += placeholder;
                literalCursor = segment.end;
            }
            output += fullText.slice(literalCursor, literal.end);
        } else if (fullyContained) {
            const placeholder = createPlaceholder(namespace, literal.kind.toUpperCase(), allocate());
            replacements.set(placeholder, { placeholder, targetText: literal.targetText });
            output += placeholder;
        } else {
            const placeholder = createPlaceholder(namespace, 'CONTEXT', allocate());
            replacements.set(placeholder, { placeholder, targetText: literal.targetText });
            output += placeholder;
        }
        cursor = overlapEnd;
    }
    output += fullText.slice(cursor, slice.end);
    return output;
}

function restoreProtectedText(
    text: string,
    namespace: string,
    replacements: ReadonlyMap<string, Replacement>,
): string {
    let output = text;
    for (const replacement of replacements.values()) {
        output = output.split(replacement.placeholder).join(replacement.targetText);
    }

    const marker = `__${namespace}_`;
    const unknownAt = output.indexOf(marker);
    if (unknownAt >= 0) {
        throw new Error('Projection provider returned an unknown literal-boundary placeholder.');
    }
    return output;
}

function scanCSharp(text: string): ScannedLiteral[] {
    const result: ScannedLiteral[] = [];
    let index = 0;

    while (index < text.length) {
        if (text.startsWith('//', index)) {
            index = skipLineComment(text, index + 2);
            continue;
        }
        if (text.startsWith('/*', index)) {
            index = skipBlockComment(text, index + 2);
            continue;
        }

        const byteArray = tryScanByteArray(text, index);
        if (byteArray) {
            result.push(byteArray);
            index = byteArray.end;
            continue;
        }

        const stringLiteral = tryScanCSharpString(text, index);
        if (stringLiteral) {
            result.push(stringLiteral);
            index = stringLiteral.end;
            continue;
        }

        if (isIdentifierStart(text[index])) {
            const end = scanIdentifier(text, index);
            const word = text.slice(index, end);
            if (word === 'true' || word === 'false') {
                result.push({
                    start: index,
                    end,
                    kind: 'boolean',
                    targetText: word === 'true' ? 'True' : 'False',
                });
            } else if (word === 'null') {
                result.push({ start: index, end, kind: 'null', targetText: 'None' });
            }
            index = end;
            continue;
        }

        if (isDigit(text[index]) && !isIdentifierPart(text[index - 1])) {
            const number = tryScanCSharpNumber(text, index);
            if (number) {
                result.push(number);
                index = number.end;
                continue;
            }
        }

        index += 1;
    }

    return result;
}

function scanPython(text: string): ScannedLiteral[] {
    const result: ScannedLiteral[] = [];
    let index = 0;

    while (index < text.length) {
        if (text[index] === '#') {
            index = skipLineComment(text, index + 1);
            continue;
        }

        const stringLiteral = tryScanPythonString(text, index);
        if (stringLiteral) {
            result.push(stringLiteral);
            index = stringLiteral.end;
            continue;
        }

        if (isIdentifierStart(text[index])) {
            const end = scanIdentifier(text, index);
            const word = text.slice(index, end);
            if (word === 'True' || word === 'False') {
                result.push({ start: index, end, kind: 'boolean', targetText: word });
            } else if (word === 'None') {
                result.push({ start: index, end, kind: 'null', targetText: word });
            }
            index = end;
            continue;
        }

        if (isDigit(text[index]) && !isIdentifierPart(text[index - 1])) {
            const end = scanPythonNumber(text, index);
            if (end > index) {
                const raw = text.slice(index, end);
                result.push({ start: index, end, kind: 'number', targetText: raw });
                index = end;
                continue;
            }
        }
        index += 1;
    }

    return result;
}

function tryScanByteArray(text: string, start: number): ScannedLiteral | undefined {
    const prefix = /^new\s+byte\s*\[\s*\]\s*\{/.exec(text.slice(start));
    if (!prefix) {
        return undefined;
    }
    const openEnd = start + prefix[0].length;
    const close = text.indexOf('}', openEnd);
    if (close < 0) {
        return undefined;
    }
    const body = text.slice(openEnd, close);
    const parts = body.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0 && body.trim().length > 0) {
        return undefined;
    }

    const lowered: string[] = [];
    for (const part of parts) {
        const numeric = parseByteLiteral(part);
        if (numeric === undefined) {
            return undefined;
        }
        lowered.push(numeric);
    }

    return {
        start,
        end: close + 1,
        kind: 'bytes',
        targetText: `bytes([${lowered.join(', ')}])`,
    };
}

function parseByteLiteral(raw: string): string | undefined {
    const clean = raw.replace(/_/g, '').replace(/[uUlL]+$/g, '');
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(clean)) {
        value = Number.parseInt(clean.slice(2), 16);
    } else if (/^0[bB][01]+$/.test(clean)) {
        value = Number.parseInt(clean.slice(2), 2);
    } else if (/^\d+$/.test(clean)) {
        value = Number.parseInt(clean, 10);
    } else {
        return undefined;
    }
    if (!Number.isInteger(value) || value < 0 || value > 255) {
        return undefined;
    }
    return String(value);
}

function tryScanCSharpNumber(text: string, start: number): ScannedLiteral | undefined {
    const match = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)(?:[uUlLfFdDmM]+)?/.exec(
        text.slice(start),
    );
    if (!match) {
        return undefined;
    }
    const raw = match[0];
    const targetText = lowerCSharpNumber(raw);
    return { start, end: start + raw.length, kind: 'number', targetText };
}

function lowerCSharpNumber(raw: string): string {
    const suffixMatch = /([uUlLfFdDmM]+)$/.exec(raw);
    const suffix = suffixMatch?.[1] ?? '';
    const numeric = suffix ? raw.slice(0, -suffix.length) : raw;
    if (/[mM]/.test(suffix)) {
        return `Decimal(${pythonStringLiteral(numeric.replace(/_/g, ''))})`;
    }
    return numeric;
}

function scanPythonNumber(text: string, start: number): number {
    const match = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?j?)/.exec(
        text.slice(start),
    );
    return match ? start + match[0].length : start;
}

function tryScanCSharpString(text: string, start: number): ScannedLiteral | undefined {
    const raw = tryScanCSharpRawString(text, start);
    if (raw) {
        return raw;
    }

    const prefix = csharpStringPrefix(text, start);
    if (!prefix) {
        return undefined;
    }

    if (prefix.interpolated) {
        return scanCSharpInterpolatedString(text, start, prefix);
    }

    const end = findCSharpStringEnd(text, prefix.contentStart, prefix.quote, prefix.verbatim);
    if (end < 0) {
        return undefined;
    }
    let finalEnd = end;
    let utf8 = false;
    if (prefix.quote === '"' && text.slice(finalEnd, finalEnd + 2).toLowerCase() === 'u8') {
        finalEnd += 2;
        utf8 = true;
    }

    const bodyEnd = end - 1;
    const body = text.slice(prefix.contentStart, bodyEnd);
    const value = decodeCSharpStringBody(body, prefix.verbatim);
    return {
        start,
        end: finalEnd,
        kind: utf8 ? 'bytes' : 'string',
        targetText: utf8 ? pythonBytesLiteral(utf8Encode(value)) : pythonStringLiteral(value),
    };
}

interface CSharpStringPrefix {
    readonly quote: '"' | "'";
    readonly interpolated: boolean;
    readonly verbatim: boolean;
    readonly contentStart: number;
}

function csharpStringPrefix(text: string, start: number): CSharpStringPrefix | undefined {
    if (text.startsWith('$@"', start) || text.startsWith('@$"', start)) {
        return { quote: '"', interpolated: true, verbatim: true, contentStart: start + 3 };
    }
    if (text.startsWith('$"', start)) {
        return { quote: '"', interpolated: true, verbatim: false, contentStart: start + 2 };
    }
    if (text.startsWith('@"', start)) {
        return { quote: '"', interpolated: false, verbatim: true, contentStart: start + 2 };
    }
    if (text[start] === '"') {
        return { quote: '"', interpolated: false, verbatim: false, contentStart: start + 1 };
    }
    if (text[start] === "'") {
        return { quote: "'", interpolated: false, verbatim: false, contentStart: start + 1 };
    }
    return undefined;
}

function tryScanCSharpRawString(text: string, start: number): ScannedLiteral | undefined {
    let dollars = 0;
    while (text[start + dollars] === '$') {
        dollars += 1;
    }
    const quoteStart = start + dollars;
    let quoteCount = 0;
    while (text[quoteStart + quoteCount] === '"') {
        quoteCount += 1;
    }
    if (quoteCount < 3) {
        return undefined;
    }
    const delimiter = '"'.repeat(quoteCount);
    const close = text.indexOf(delimiter, quoteStart + quoteCount);
    if (close < 0) {
        return {
            start,
            end: text.length,
            kind: 'unsupported',
            targetText: '',
        };
    }
    return {
        start,
        end: close + quoteCount,
        kind: 'unsupported',
        targetText: '',
    };
}

function scanCSharpInterpolatedString(
    text: string,
    start: number,
    prefix: CSharpStringPrefix,
): ScannedLiteral | undefined {
    const segments: SegmentReplacement[] = [];
    let index = prefix.contentStart;
    let segmentStart = index;

    while (index < text.length) {
        const char = text[index];
        if (char === '"') {
            if (prefix.verbatim && text[index + 1] === '"') {
                index += 2;
                continue;
            }
            if (!prefix.verbatim && isEscaped(text, index)) {
                index += 1;
                continue;
            }
            addCSharpInterpolationSegment(text, segmentStart, index, prefix.verbatim, segments);
            return {
                start,
                end: index + 1,
                kind: 'interpolated',
                targetText: '',
                segmentReplacements: segments,
            };
        }

        if (char === '{' && text[index + 1] === '{') {
            index += 2;
            continue;
        }
        if (char === '}' && text[index + 1] === '}') {
            index += 2;
            continue;
        }
        if (char === '{') {
            addCSharpInterpolationSegment(text, segmentStart, index, prefix.verbatim, segments);
            const close = findInterpolationExpressionEnd(text, index + 1);
            if (close < 0) {
                return undefined;
            }
            index = close + 1;
            segmentStart = index;
            continue;
        }

        if (!prefix.verbatim && char === '\\') {
            index = skipCSharpEscape(text, index);
            continue;
        }
        index += 1;
    }
    return undefined;
}

function addCSharpInterpolationSegment(
    text: string,
    start: number,
    end: number,
    verbatim: boolean,
    segments: SegmentReplacement[],
): void {
    if (end <= start) {
        return;
    }
    const raw = text.slice(start, end);
    const decoded = decodeCSharpStringBody(raw, verbatim).replace(/\{\{/g, '{').replace(/\}\}/g, '}');
    segments.push({ start, end, targetText: escapePythonFStringSegment(decoded) });
}

function findInterpolationExpressionEnd(text: string, start: number): number {
    let depth = 1;
    let index = start;
    while (index < text.length) {
        if (text.startsWith('//', index)) {
            index = skipLineComment(text, index + 2);
            continue;
        }
        if (text.startsWith('/*', index)) {
            index = skipBlockComment(text, index + 2);
            continue;
        }
        const stringLiteral = tryScanCSharpString(text, index);
        if (stringLiteral) {
            index = stringLiteral.end;
            continue;
        }
        if (text[index] === '{') {
            depth += 1;
        } else if (text[index] === '}') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
        index += 1;
    }
    return -1;
}

function findCSharpStringEnd(
    text: string,
    start: number,
    quote: '"' | "'",
    verbatim: boolean,
): number {
    let index = start;
    while (index < text.length) {
        if (text[index] === quote) {
            if (verbatim && quote === '"' && text[index + 1] === '"') {
                index += 2;
                continue;
            }
            if (!verbatim && isEscaped(text, index)) {
                index += 1;
                continue;
            }
            return index + 1;
        }
        if (!verbatim && text[index] === '\n') {
            return -1;
        }
        if (!verbatim && text[index] === '\\') {
            index = skipCSharpEscape(text, index);
            continue;
        }
        index += 1;
    }
    return -1;
}

function decodeCSharpStringBody(body: string, verbatim: boolean): string {
    if (verbatim) {
        return body.replace(/""/g, '"');
    }
    let output = '';
    let index = 0;
    while (index < body.length) {
        if (body[index] !== '\\') {
            output += body[index++];
            continue;
        }
        const escape = decodeCSharpEscape(body, index);
        output += escape.value;
        index = escape.end;
    }
    return output;
}

function decodeCSharpEscape(text: string, start: number): { value: string; end: number } {
    const code = text[start + 1];
    const simple: Record<string, string> = {
        "'": "'",
        '"': '"',
        '\\': '\\',
        '0': '\0',
        a: '\x07',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\x0b',
    };
    if (code in simple) {
        return { value: simple[code], end: start + 2 };
    }
    if (code === 'u') {
        const hex = text.slice(start + 2, start + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new Error('Malformed C# Unicode escape at literal boundary.');
        }
        return { value: String.fromCodePoint(Number.parseInt(hex, 16)), end: start + 6 };
    }
    if (code === 'U') {
        const hex = text.slice(start + 2, start + 10);
        if (!/^[0-9a-fA-F]{8}$/.test(hex)) {
            throw new Error('Malformed C# Unicode escape at literal boundary.');
        }
        return { value: String.fromCodePoint(Number.parseInt(hex, 16)), end: start + 10 };
    }
    if (code === 'x') {
        let end = start + 2;
        while (end < text.length && end < start + 6 && /[0-9a-fA-F]/.test(text[end])) {
            end += 1;
        }
        if (end === start + 2) {
            throw new Error('Malformed C# hexadecimal escape at literal boundary.');
        }
        return {
            value: String.fromCodePoint(Number.parseInt(text.slice(start + 2, end), 16)),
            end,
        };
    }
    throw new Error(`Unsupported C# escape sequence \\${code ?? ''} at literal boundary.`);
}

function skipCSharpEscape(text: string, start: number): number {
    return decodeCSharpEscape(text, start).end;
}

function tryScanPythonString(text: string, start: number): ScannedLiteral | undefined {
    let index = start;
    let prefix = '';
    while (index < text.length && /[rRbBuUfF]/.test(text[index]) && prefix.length < 2) {
        prefix += text[index++];
    }
    if (text[index] !== '"' && text[index] !== "'") {
        return undefined;
    }
    if (prefix.length > 0 && start > 0 && isIdentifierPart(text[start - 1])) {
        return undefined;
    }

    const quote = text[index];
    const triple = text.slice(index, index + 3) === quote.repeat(3);
    const delimiter = triple ? quote.repeat(3) : quote;
    const bodyStart = index + delimiter.length;
    const rawMode = /r/i.test(prefix);
    let cursor = bodyStart;
    while (cursor < text.length) {
        if (text.startsWith(delimiter, cursor) && (rawMode || !isEscaped(text, cursor))) {
            const end = cursor + delimiter.length;
            return {
                start,
                end,
                kind: /b/i.test(prefix) ? 'bytes' : /f/i.test(prefix) ? 'interpolated' : 'string',
                targetText: text.slice(start, end),
            };
        }
        if (!triple && text[cursor] === '\n') {
            return undefined;
        }
        cursor += 1;
    }
    return undefined;
}

function pythonStringLiteral(value: string): string {
    return `"${escapePythonString(value)}"`;
}

function escapePythonString(value: string): string {
    let output = '';
    for (const char of value) {
        const code = char.codePointAt(0)!;
        if (char === '\\') output += '\\\\';
        else if (char === '"') output += '\\"';
        else if (char === '\n') output += '\\n';
        else if (char === '\r') output += '\\r';
        else if (char === '\t') output += '\\t';
        else if (char === '\0') output += '\\0';
        else if (code < 0x20 || code === 0x7f) output += `\\x${code.toString(16).padStart(2, '0')}`;
        else output += char;
    }
    return output;
}

function escapePythonFStringSegment(value: string): string {
    return escapePythonString(value).replace(/\{/g, '{{').replace(/\}/g, '}}');
}

function pythonBytesLiteral(bytes: readonly number[]): string {
    let output = 'b"';
    for (const byte of bytes) {
        if (byte === 0x5c) output += '\\\\';
        else if (byte === 0x22) output += '\\"';
        else if (byte === 0x0a) output += '\\n';
        else if (byte === 0x0d) output += '\\r';
        else if (byte === 0x09) output += '\\t';
        else if (byte >= 0x20 && byte <= 0x7e) output += String.fromCharCode(byte);
        else output += `\\x${byte.toString(16).padStart(2, '0')}`;
    }
    return `${output}"`;
}

function utf8Encode(value: string): number[] {
    const result: number[] = [];
    for (const char of value) {
        const code = char.codePointAt(0)!;
        if (code <= 0x7f) {
            result.push(code);
        } else if (code <= 0x7ff) {
            result.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code <= 0xffff) {
            result.push(
                0xe0 | (code >> 12),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f),
            );
        } else {
            result.push(
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 0x3f),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f),
            );
        }
    }
    return result;
}

function textRangeToOffsets(text: string, range: TextRange): OffsetRange {
    const start = textPositionToOffset(text, range.start);
    const end = textPositionToOffset(text, range.end);
    if (end < start) {
        throw new RangeError('Literal-boundary text range end precedes its start.');
    }
    return { start, end };
}

function textPositionToOffset(text: string, position: TextPosition): number {
    if (
        !Number.isInteger(position.line) ||
        !Number.isInteger(position.character) ||
        position.line < 0 ||
        position.character < 0
    ) {
        throw new RangeError('Literal-boundary text positions must be non-negative integers.');
    }
    let line = 0;
    let lineStart = 0;
    while (line < position.line) {
        const newline = text.indexOf('\n', lineStart);
        if (newline < 0) {
            throw new RangeError('Literal-boundary text position line is beyond the source text.');
        }
        lineStart = newline + 1;
        line += 1;
    }
    const physicalEnd = text.indexOf('\n', lineStart);
    const lineEnd = physicalEnd < 0 ? text.length : physicalEnd;
    const logicalEnd = lineEnd > lineStart && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const offset = lineStart + position.character;
    if (offset > logicalEnd) {
        throw new RangeError('Literal-boundary text position character is beyond the logical line.');
    }
    return offset;
}

function chooseNamespace(texts: readonly (string | undefined)[]): string {
    for (let index = 0; ; index += 1) {
        const candidate = `TPB${index}`;
        const marker = `__${candidate}_`;
        if (texts.every((text) => text === undefined || !text.includes(marker))) {
            return candidate;
        }
    }
}

function createPlaceholder(namespace: string, kind: string, index: number): string {
    return `__${namespace}_${kind}_${index}__`;
}

function assertSupportedPair(sourceLanguage: string, targetLanguage: string): void {
    const source = sourceLanguage.trim().toLowerCase();
    const target = targetLanguage.trim().toLowerCase();
    if (!['csharp', 'c#', 'cs'].includes(source) || !['python', 'py'].includes(target)) {
        throw new Error(
            `Literal boundary is not available for ${sourceLanguage || '<unknown>'} -> ${targetLanguage || '<unknown>'}; refusing an unprotected provider request.`,
        );
    }
}

function assertRange(text: string, range: OffsetRange): void {
    if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start ||
        range.end > text.length
    ) {
        throw new RangeError('Literal focus must be a valid half-open source range.');
    }
}

function rangesOverlap(a: OffsetRange, b: { start: number; end: number }): boolean {
    return a.start < b.end && b.start < a.end;
}

function rangeContains(outer: OffsetRange, inner: { start: number; end: number }): boolean {
    return outer.start <= inner.start && outer.end >= inner.end;
}

function skipLineComment(text: string, start: number): number {
    const newline = text.indexOf('\n', start);
    return newline < 0 ? text.length : newline + 1;
}

function skipBlockComment(text: string, start: number): number {
    const close = text.indexOf('*/', start);
    return close < 0 ? text.length : close + 2;
}

function scanIdentifier(text: string, start: number): number {
    let end = start + 1;
    while (end < text.length && isIdentifierPart(text[end])) {
        end += 1;
    }
    return end;
}

function isIdentifierStart(char: string | undefined): boolean {
    return char !== undefined && /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string | undefined): boolean {
    return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function isDigit(char: string | undefined): boolean {
    return char !== undefined && /[0-9]/.test(char);
}

function isEscaped(text: string, index: number): boolean {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
        backslashes += 1;
    }
    return backslashes % 2 === 1;
}
