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

export interface ProjectionSessionOptions {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly contextLines: number;
    readonly policy: SemanticPolicyProfile;
    readonly harness: HarnessProfile;
}

/**
 * An accepted provider result plus the authoritative source ownership chosen by the session.
 *
 * Providers deliberately do not supply `sourceOffsets`: they translate the requested fragment,
 * while the session decides which exact document span that fragment owns after revision checks.
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

    /**
     * Widen the next projection request without advancing the source revision.
     *
     * Hosts use this when target ownership invariants require a larger replacement envelope than
     * the raw edit itself (for example, to avoid partially replacing an existing target segment).
     */
    requireProjectionRange(range: OffsetRange): void {
        assertNonEmptyOffsetRange(range);
        this.dirtyOffsets = unionOffsetRanges(this.dirtyOffsets, range);
    }

    async refresh(
        document: DocumentSnapshot,
        provider: ProjectionProvider,
    ): Promise<ProjectionCommit | undefined> {
        const capturedRevision = this.revision;
        this.cancelActive();

        const cancellation = new CoreCancellationController();
        this.cancellation = cancellation;

        const dirtyRange = this.dirtyOffsets
            ? offsetRangeToTextRange(document.text, this.dirtyOffsets)
            : undefined;
        const slice = selectBoundedSlice(document.text, dirtyRange, this.options.contextLines);
        const sourceOffsets = textRangeToOffsetRange(document.text, slice.range);
        const result = await provider.project({
            sourceLanguage: this.options.sourceLanguage,
            targetLanguage: this.options.targetLanguage,
            sourceUri: document.uri,
            revision: capturedRevision,
            sourceRegion: slice.text,
            sourceRange: slice.range,
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

        this.previousSourceRegion = slice.text;
        this.previousSourceRange = slice.range;
        this.previousProjection = result.text;
        this.dirtyOffsets = undefined;

        return {
            ...result,
            sourceOffsets,
            sourceRange: slice.range,
        };
    }
}

export function offsetRangeToTextRange(text: string, range: OffsetRange): TextRange {
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

function assertNonEmptyOffsetRange(range: OffsetRange): void {
    if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end <= range.start
    ) {
        throw new RangeError('Required projection range must be a non-empty half-open offset range.');
    }
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
