import {
    OffsetRange,
    changedOffsetsAfterEdits,
    rebaseDirtyOffsetRange,
    unionOffsetRanges,
} from './changes';
import {
    DocumentSnapshot,
    HarnessProfile,
    ProjectionSlice,
    SemanticPolicyProfile,
    TextChange,
    TextPosition,
    TextRange,
} from './model';
import { CoreCancellationController, ProjectionProvider, ProjectionResult } from './provider';

export { changedOffsetsAfterEdits, rebaseDirtyOffsetRange as rebaseOffsetRange } from './changes';

const DEFAULT_MAX_CONTEXT_CHARACTERS = 12_000;

export interface ProjectionSessionOptions {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly contextLines: number;
    readonly maxContextCharacters?: number;
    readonly policy: SemanticPolicyProfile;
    readonly harness: HarnessProfile;
}

/**
 * An accepted provider result plus the authoritative source ownership chosen by the session.
 *
 * Provider context may be larger than this range. `sourceOffsets`/`sourceRange` describe only the
 * exact focus whose returned target text is allowed to own the buffer.
 */
export interface ProjectionCommit extends ProjectionResult {
    readonly sourceOffsets: OffsetRange;
    readonly sourceRange: TextRange;
}

export class ProjectionSession {
    private revision = 0;
    private dirtyOffsets?: OffsetRange;
    private previousSourceRegion?: string;
    private previousSourceRange?: TextRange;
    private previousProjection?: string;
    private cancellation?: CoreCancellationController;

    constructor(private readonly options: ProjectionSessionOptions) {}

    get currentRevision(): number {
        return this.revision;
    }

    get pendingDirtyOffsets(): OffsetRange | undefined {
        return this.dirtyOffsets
            ? { start: this.dirtyOffsets.start, end: this.dirtyOffsets.end }
            : undefined;
    }

    cancelActive(): void {
        this.cancellation?.cancel();
    }

    invalidate(changes: readonly TextChange[] = []): number {
        this.revision += 1;
        this.cancelActive();

        if (changes.length > 0) {
            const rebasedDirty = this.dirtyOffsets
                ? rebaseDirtyOffsetRange(this.dirtyOffsets, changes)
                : undefined;
            const changedOffsets = changedOffsetsAfterEdits(changes);
            this.dirtyOffsets = unionOffsetRanges(rebasedDirty, changedOffsets);
        }

        return this.revision;
    }

    /** Widen or establish the exact source focus for the next provider request. */
    requireProjectionRange(range: OffsetRange): void {
        assertOffsetRange(range, true);
        this.dirtyOffsets = unionOffsetRanges(this.dirtyOffsets, range);
    }

    async refresh(
        document: DocumentSnapshot,
        provider: ProjectionProvider,
    ): Promise<ProjectionCommit | undefined> {
        const focusOffsets = normalizeProjectionFocus(document.text, this.dirtyOffsets);
        if (!focusOffsets) {
            return undefined;
        }

        const capturedRevision = this.revision;
        this.cancelActive();

        const cancellation = new CoreCancellationController();
        this.cancellation = cancellation;

        const focusRange = offsetRangeToTextRange(document.text, focusOffsets);
        const focusRegion = document.text.slice(focusOffsets.start, focusOffsets.end);
        const context = selectBoundedContext(
            document.text,
            focusOffsets,
            this.options.contextLines,
            this.options.maxContextCharacters ?? DEFAULT_MAX_CONTEXT_CHARACTERS,
        );

        const result = await provider.project({
            sourceLanguage: this.options.sourceLanguage,
            targetLanguage: this.options.targetLanguage,
            sourceUri: document.uri,
            revision: capturedRevision,
            sourceRegion: context.text,
            sourceRange: context.range,
            focusRegion,
            focusRange,
            previousSourceRegion: this.previousSourceRegion,
            previousSourceRange: this.previousSourceRange,
            previousProjection: this.previousProjection,
            policy: this.options.policy,
            harness: this.options.harness,
            signal: cancellation.signal,
        });

        if (
            cancellation.signal.aborted ||
            capturedRevision !== this.revision ||
            result.revision !== this.revision
        ) {
            return undefined;
        }

        this.previousSourceRegion = context.text;
        this.previousSourceRange = context.range;
        this.previousProjection = result.text;
        this.dirtyOffsets = undefined;

        return {
            ...result,
            sourceOffsets: focusOffsets,
            sourceRange: focusRange,
        };
    }
}

export function offsetRangeToTextRange(text: string, range: OffsetRange): TextRange {
    assertOffsetRangeWithinText(range, text.length, true);
    return {
        start: offsetToPosition(text, range.start),
        end: offsetToPosition(text, range.end),
    };
}

export function textRangeToOffsetRange(text: string, range: TextRange): OffsetRange {
    const start = positionToOffset(text, range.start);
    const end = positionToOffset(text, range.end);
    if (end < start) {
        throw new RangeError('Text range end must not precede its start.');
    }
    return { start, end };
}

/** Existing line-bounded helper retained for line-oriented callers/tests. */
export function selectBoundedSlice(
    text: string,
    changedRange: TextRange | undefined,
    contextLines: number,
): ProjectionSlice {
    const lines = text.split(/\r?\n/);
    const lastLine = Math.max(0, lines.length - 1);
    const radius = Math.max(0, contextLines);

    const changedStart = changedRange?.start.line ?? 0;
    const changedEnd = changedRange?.end.line ?? Math.min(lastLine, radius * 2);
    const startLine = clamp(changedStart - radius, 0, lastLine);
    const endLine = clamp(changedEnd + radius, startLine, lastLine);

    return {
        text: lines.slice(startLine, endLine + 1).join('\n'),
        range: {
            start: { line: startLine, character: 0 },
            end: { line: endLine, character: lines[endLine]?.length ?? 0 },
        },
    };
}

/**
 * Select provider context around an exact focus while enforcing both line and character bounds.
 * The returned context always contains the entire focus.
 */
export function selectBoundedContext(
    text: string,
    focus: OffsetRange,
    contextLines: number,
    maxCharacters = DEFAULT_MAX_CONTEXT_CHARACTERS,
): ProjectionSlice {
    assertOffsetRangeWithinText(focus, text.length, false);
    if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) {
        throw new RangeError('Maximum context characters must be a positive integer.');
    }

    const focusLength = focus.end - focus.start;
    if (focusLength > maxCharacters) {
        throw new RangeError(
            `Projection focus length ${focusLength} exceeds maximum context size ${maxCharacters}.`,
        );
    }

    const lineContext = selectBoundedSlice(
        text,
        offsetRangeToTextRange(text, focus),
        contextLines,
    );
    const lineOffsets = textRangeToOffsetRange(text, lineContext.range);
    let start = lineOffsets.start;
    let end = lineOffsets.end;

    if (end - start > maxCharacters) {
        const remaining = maxCharacters - focusLength;
        const beforeBudget = Math.floor(remaining / 2);
        start = Math.max(lineOffsets.start, focus.start - beforeBudget);
        end = Math.min(lineOffsets.end, start + maxCharacters);

        if (end < focus.end) {
            end = focus.end;
            start = Math.max(lineOffsets.start, end - maxCharacters);
        }
        if (start > focus.start) {
            start = focus.start;
            end = Math.min(lineOffsets.end, start + maxCharacters);
        }
    }

    return sliceFromOffsets(text, { start, end });
}

/**
 * Convert a possibly zero-width edit marker into a non-empty focus when source text remains.
 * A deletion marker uses its containing logical line (or newline for an empty line) so providers
 * never receive impossible zero-width ownership.
 */
export function normalizeProjectionFocus(
    text: string,
    requested: OffsetRange | undefined,
): OffsetRange | undefined {
    if (!requested) {
        return undefined;
    }
    assertOffsetRangeWithinText(requested, text.length, true);
    if (requested.end > requested.start) {
        return { start: requested.start, end: requested.end };
    }
    if (text.length === 0) {
        return undefined;
    }

    const point = requested.start;
    const probe = Math.min(point, text.length - 1);
    const previousNewline = text.lastIndexOf('\n', Math.max(-1, probe - 1));
    const lineStart = previousNewline + 1;
    const newline = text.indexOf('\n', probe);
    const physicalEnd = newline < 0 ? text.length : newline;
    const logicalEnd =
        physicalEnd > lineStart && text.charCodeAt(physicalEnd - 1) === 13
            ? physicalEnd - 1
            : physicalEnd;

    if (logicalEnd > lineStart) {
        return { start: lineStart, end: logicalEnd };
    }
    if (newline >= 0) {
        return { start: lineStart, end: newline + 1 };
    }
    return { start: Math.max(0, lineStart - 1), end: lineStart };
}

/**
 * Expand an exact focus requirement only when the focus itself would partially replace an
 * existing source-owned target segment. Provider context overlap is intentionally irrelevant.
 */
export function stabilizeProjectionRequirement(
    text: string,
    pendingDirtyOffsets: OffsetRange | undefined,
    ownedRanges: readonly OffsetRange[],
): OffsetRange | undefined {
    for (const range of ownedRanges) {
        assertOffsetRangeWithinText(range, text.length, false);
    }

    let required = normalizeProjectionFocus(text, pendingDirtyOffsets);
    if (!required) {
        return undefined;
    }

    for (let iteration = 0; iteration <= ownedRanges.length; iteration += 1) {
        let expanded: OffsetRange | undefined = required;
        let absorbed = false;

        for (const owned of ownedRanges) {
            if (rangesOverlap(required, owned) && !rangeContains(required, owned)) {
                expanded = unionOffsetRanges(expanded, owned);
                absorbed = true;
            }
        }

        if (!absorbed) {
            return required;
        }
        required = expanded!;
    }

    throw new Error('Projection replacement requirement did not stabilize.');
}

/**
 * Select the next bounded focus from a coverage gap. Both line count and character count are hard
 * upper bounds, so a minified/one-line source cannot silently become a whole-file request.
 */
export function selectCoverageRequirement(
    text: string,
    gap: OffsetRange,
    maxLines: number,
    maxCharacters: number,
): OffsetRange {
    assertOffsetRangeWithinText(gap, text.length, false);
    if (!Number.isInteger(maxLines) || maxLines <= 0) {
        throw new RangeError('Coverage focus lines must be a positive integer.');
    }
    if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) {
        throw new RangeError('Coverage focus characters must be a positive integer.');
    }

    const hardEnd = Math.min(gap.end, gap.start + maxCharacters);
    let end = hardEnd;
    let lines = 1;

    for (let index = gap.start; index < hardEnd; index += 1) {
        if (text.charCodeAt(index) !== 10) {
            continue;
        }
        if (lines >= maxLines) {
            end = index + 1;
            break;
        }
        lines += 1;
    }

    if (
        end < gap.end &&
        end > gap.start &&
        text.charCodeAt(end - 1) === 13 &&
        text.charCodeAt(end) === 10
    ) {
        end = Math.min(gap.end, end + 1);
    }

    return { start: gap.start, end: Math.max(gap.start + 1, end) };
}

function sliceFromOffsets(text: string, range: OffsetRange): ProjectionSlice {
    assertOffsetRangeWithinText(range, text.length, true);
    return {
        text: text.slice(range.start, range.end),
        range: offsetRangeToTextRange(text, range),
    };
}

function assertOffsetRange(range: OffsetRange, allowEmpty: boolean): void {
    if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start ||
        (!allowEmpty && range.end === range.start)
    ) {
        throw new RangeError(
            allowEmpty
                ? 'Offset range must be a half-open range of non-negative integer offsets.'
                : 'Offset range must be a non-empty half-open range of non-negative integer offsets.',
        );
    }
}

function assertOffsetRangeWithinText(
    range: OffsetRange,
    textLength: number,
    allowEmpty: boolean,
): void {
    assertOffsetRange(range, allowEmpty);
    if (range.end > textLength) {
        throw new RangeError(`Offset range ends at ${range.end}, beyond text length ${textLength}.`);
    }
}

function rangesOverlap(a: OffsetRange, b: OffsetRange): boolean {
    return a.start < b.end && b.start < a.end;
}

function rangeContains(outer: OffsetRange, inner: OffsetRange): boolean {
    return outer.start <= inner.start && outer.end >= inner.end;
}

function positionToOffset(text: string, position: TextPosition): number {
    if (
        !Number.isInteger(position.line) ||
        !Number.isInteger(position.character) ||
        position.line < 0 ||
        position.character < 0
    ) {
        throw new RangeError('Text positions must use non-negative integer line and character values.');
    }

    let line = 0;
    let lineStart = 0;
    while (line < position.line) {
        const newline = text.indexOf('\n', lineStart);
        if (newline < 0) {
            throw new RangeError(`Text position line ${position.line} is outside the document.`);
        }
        lineStart = newline + 1;
        line += 1;
    }

    const newline = text.indexOf('\n', lineStart);
    const physicalLineEnd = newline < 0 ? text.length : newline;
    const logicalLineEnd =
        physicalLineEnd > lineStart && text.charCodeAt(physicalLineEnd - 1) === 13
            ? physicalLineEnd - 1
            : physicalLineEnd;
    const lineLength = logicalLineEnd - lineStart;

    if (position.character > lineLength) {
        throw new RangeError(
            `Text position character ${position.character} exceeds line ${position.line} length ${lineLength}.`,
        );
    }

    return lineStart + position.character;
}

function offsetToPosition(text: string, rawOffset: number): { line: number; character: number } {
    const offset = clamp(rawOffset, 0, text.length);
    let line = 0;
    let lineStart = 0;

    for (let index = 0; index < offset; index += 1) {
        if (text.charCodeAt(index) === 10) {
            line += 1;
            lineStart = index + 1;
        }
    }

    return {
        line,
        character: offset - lineStart,
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
