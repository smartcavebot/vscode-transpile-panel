import { DocumentSnapshot, HarnessProfile, ProjectionSlice, SemanticPolicyProfile, TextChange, TextRange } from './model';
import { CoreCancellationController, ProjectionProvider, ProjectionResult } from './provider';

export interface ProjectionSessionOptions {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly contextLines: number;
    readonly policy: SemanticPolicyProfile;
    readonly harness: HarnessProfile;
}

interface OffsetRange {
    readonly start: number;
    readonly end: number;
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

    invalidate(changes: readonly TextChange[] = []): number {
        this.revision += 1;
        this.cancellation?.cancel();

        if (changes.length > 0) {
            const normalizedChanges = normalizeChanges(changes);
            const rebasedDirty = this.dirtyOffsets
                ? rebaseOffsetRange(this.dirtyOffsets, normalizedChanges)
                : undefined;
            const changedOffsets = changedOffsetsAfterEdits(normalizedChanges);
            this.dirtyOffsets = unionOffsetRanges(rebasedDirty, changedOffsets);
        }

        return this.revision;
    }

    async refresh(
        document: DocumentSnapshot,
        provider: ProjectionProvider,
    ): Promise<ProjectionResult | undefined> {
        const capturedRevision = this.revision;
        this.cancellation?.cancel();

        const cancellation = new CoreCancellationController();
        this.cancellation = cancellation;

        const dirtyRange = this.dirtyOffsets
            ? offsetRangeToTextRange(document.text, this.dirtyOffsets)
            : undefined;
        const slice = selectBoundedSlice(document.text, dirtyRange, this.options.contextLines);
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
        return result;
    }
}

export function rebaseOffsetRange(
    range: OffsetRange,
    changes: readonly TextChange[],
): OffsetRange {
    const normalizedChanges = normalizeChanges(changes);
    const start = mapOffsetThroughChanges(range.start, normalizedChanges, 'start');
    const end = mapOffsetThroughChanges(range.end, normalizedChanges, 'end');

    return start <= end
        ? { start, end }
        : { start: end, end: start };
}

export function changedOffsetsAfterEdits(
    changes: readonly TextChange[],
): OffsetRange | undefined {
    const normalizedChanges = normalizeChanges(changes);
    let cumulativeDelta = 0;
    let dirty: OffsetRange | undefined;

    for (const change of normalizedChanges) {
        const postStart = change.rangeOffset + cumulativeDelta;
        const postEnd = postStart + change.text.length;
        dirty = unionOffsetRanges(dirty, { start: postStart, end: postEnd });
        cumulativeDelta += change.text.length - change.rangeLength;
    }

    return dirty;
}

export function offsetRangeToTextRange(text: string, range: OffsetRange): TextRange {
    return {
        start: offsetToPosition(text, range.start),
        end: offsetToPosition(text, range.end),
    };
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

function normalizeChanges(changes: readonly TextChange[]): readonly TextChange[] {
    const normalized = changes
        .map((change, index) => ({ change, index }))
        .sort((a, b) =>
            a.change.rangeOffset - b.change.rangeOffset ||
            a.change.rangeLength - b.change.rangeLength ||
            a.index - b.index,
        )
        .map(({ change }) => change);

    let previousEnd = -1;
    for (const change of normalized) {
        if (change.rangeOffset < 0 || change.rangeLength < 0) {
            throw new RangeError('Text change offsets and lengths must be non-negative.');
        }
        if (change.rangeOffset < previousEnd) {
            throw new RangeError('Text changes in one revision must not overlap.');
        }
        previousEnd = Math.max(previousEnd, change.rangeOffset + change.rangeLength);
    }

    return normalized;
}

function mapOffsetThroughChanges(
    offset: number,
    changes: readonly TextChange[],
    boundary: 'start' | 'end',
): number {
    let cumulativeDelta = 0;

    for (const change of changes) {
        const oldStart = change.rangeOffset;
        const oldEnd = oldStart + change.rangeLength;
        const newStart = oldStart + cumulativeDelta;
        const newEnd = newStart + change.text.length;

        if (offset < oldStart) {
            return offset + cumulativeDelta;
        }

        if (change.rangeLength === 0 && offset === oldStart) {
            return boundary === 'start' ? newEnd : newStart;
        }

        if (offset === oldStart) {
            return newStart;
        }

        if (offset < oldEnd) {
            return boundary === 'start' ? newStart : newEnd;
        }

        if (offset === oldEnd) {
            return newEnd;
        }

        cumulativeDelta += change.text.length - change.rangeLength;
    }

    return offset + cumulativeDelta;
}

function unionOffsetRanges(
    a: OffsetRange | undefined,
    b: OffsetRange | undefined,
): OffsetRange | undefined {
    if (!a) return b;
    if (!b) return a;
    return {
        start: Math.min(a.start, b.start),
        end: Math.max(a.end, b.end),
    };
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
