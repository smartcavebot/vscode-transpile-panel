import {
    OffsetRange,
    changeTouchesTrackedRange,
    normalizeTextChanges,
    rangeContains,
    rangesOverlap,
    rebaseTrackedOffsetRange,
} from './changes';
import { TextChange } from './model';

export interface ProjectionSegment {
    readonly source: OffsetRange;
    readonly text: string;
    readonly stale: boolean;
}

/**
 * Host-neutral target text assembled from independently translated source-owned segments.
 *
 * The buffer deliberately does not invent separators or assume source/target line parity.
 * Segment target text is concatenated exactly in source order. Coverage gaps remain gaps in
 * the model and can be surfaced by the host separately.
 */
export class TargetProjectionBuffer {
    private sourceRevision: number;
    private values: ProjectionSegment[] = [];

    constructor(sourceRevision = 0) {
        assertRevision(sourceRevision);
        this.sourceRevision = sourceRevision;
    }

    get currentRevision(): number {
        return this.sourceRevision;
    }

    get text(): string {
        return this.values.map((segment) => segment.text).join('');
    }

    get segments(): readonly ProjectionSegment[] {
        return this.values.map(cloneSegment);
    }

    get hasStaleSegments(): boolean {
        return this.values.some((segment) => segment.stale);
    }

    /**
     * Commit a target fragment for an exact source-owned range.
     *
     * A new projection may replace zero or more whole existing segments. It may not
     * partially overlap an existing segment, because doing so would require finer-grained
     * source↔target correspondence than this buffer currently possesses.
     */
    applyProjection(source: OffsetRange, text: string, revision = this.sourceRevision): void {
        assertCurrentRevision(this.sourceRevision, revision);
        assertSourceRange(source);

        const retained: ProjectionSegment[] = [];
        for (const segment of this.values) {
            if (!rangesOverlap(source, segment.source)) {
                retained.push(segment);
                continue;
            }

            if (!rangeContains(source, segment.source)) {
                throw new RangeError(
                    'Projection range partially overlaps an existing target segment; reproject a range that owns the complete segment.',
                );
            }
        }

        retained.push({
            source: { start: source.start, end: source.end },
            text,
            stale: false,
        });
        retained.sort(compareSegmentsBySource);
        assertValidSegments(retained);
        this.values = retained;
    }

    /**
     * Advance source ownership through a later source revision.
     *
     * Untouched segments remain fresh and simply move with edits before them. A segment
     * touched by an edit becomes stale. If the source text owned by a segment is deleted
     * completely, the corresponding target segment disappears immediately rather than
     * surviving as zero-width ghost ownership. If one replacement causes surviving stale
     * ownership ranges to overlap, they are conservatively coalesced: preserving exact
     * target text order while discarding a source boundary that is no longer trustworthy.
     */
    rebase(changes: readonly TextChange[], nextRevision: number): void {
        assertRevision(nextRevision);
        if (nextRevision <= this.sourceRevision) {
            throw new RangeError(
                `Projection buffer revision must advance beyond ${this.sourceRevision}; received ${nextRevision}.`,
            );
        }

        const normalized = normalizeTextChanges(changes);
        if (normalized.length > 0) {
            const rebased = this.values
                .map((segment) => ({
                    source: rebaseTrackedOffsetRange(segment.source, normalized),
                    text: segment.text,
                    stale:
                        segment.stale ||
                        normalized.some((change) => changeTouchesTrackedRange(segment.source, change)),
                }))
                .filter((segment) => segment.source.end > segment.source.start);
            this.values = coalesceOverlappingSegments(rebased);
            assertValidSegments(this.values);
        }

        this.sourceRevision = nextRevision;
    }

    coverageGaps(sourceLength: number): readonly OffsetRange[] {
        return computeCoverageGaps(this.values, sourceLength);
    }

    freshCoverageGaps(sourceLength: number): readonly OffsetRange[] {
        return computeCoverageGaps(
            this.values.filter((segment) => !segment.stale),
            sourceLength,
        );
    }

    staleRanges(): readonly OffsetRange[] {
        const ranges = this.values
            .filter((segment) => segment.stale)
            .map((segment) => segment.source);
        return mergeOverlappingRanges(ranges);
    }
}

function coalesceOverlappingSegments(
    segments: readonly ProjectionSegment[],
): ProjectionSegment[] {
    const result: ProjectionSegment[] = [];

    for (const segment of segments) {
        const previous = result[result.length - 1];
        if (!previous || !rangesOverlap(previous.source, segment.source)) {
            result.push(cloneSegment(segment));
            continue;
        }

        result[result.length - 1] = {
            source: {
                start: Math.min(previous.source.start, segment.source.start),
                end: Math.max(previous.source.end, segment.source.end),
            },
            text: previous.text + segment.text,
            stale: true,
        };
    }

    return result;
}

function computeCoverageGaps(
    segments: readonly ProjectionSegment[],
    sourceLength: number,
): readonly OffsetRange[] {
    if (!Number.isInteger(sourceLength) || sourceLength < 0) {
        throw new RangeError('Source length must be a non-negative integer.');
    }

    const sorted = [...segments].sort(compareSegmentsBySource);
    const gaps: OffsetRange[] = [];
    let cursor = 0;

    for (const segment of sorted) {
        if (segment.source.end > sourceLength) {
            throw new RangeError(
                `Projection segment ends at ${segment.source.end}, beyond source length ${sourceLength}.`,
            );
        }
        if (segment.source.start > cursor) {
            gaps.push({ start: cursor, end: segment.source.start });
        }
        cursor = Math.max(cursor, segment.source.end);
    }

    if (cursor < sourceLength) {
        gaps.push({ start: cursor, end: sourceLength });
    }

    return gaps;
}

function mergeOverlappingRanges(ranges: readonly OffsetRange[]): readonly OffsetRange[] {
    if (ranges.length === 0) {
        return [];
    }

    const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
    const result: OffsetRange[] = [];

    for (const range of sorted) {
        const previous = result[result.length - 1];
        if (!previous || previous.end < range.start) {
            result.push({ start: range.start, end: range.end });
            continue;
        }
        result[result.length - 1] = {
            start: previous.start,
            end: Math.max(previous.end, range.end),
        };
    }

    return result;
}

function assertValidSegments(segments: readonly ProjectionSegment[]): void {
    for (const segment of segments) {
        assertSourceRange(segment.source);
    }
    for (let index = 1; index < segments.length; index += 1) {
        if (rangesOverlap(segments[index - 1].source, segments[index].source)) {
            throw new Error('Projection buffer contains overlapping source ownership.');
        }
    }
}

function assertSourceRange(range: OffsetRange): void {
    if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end <= range.start
    ) {
        throw new RangeError('Projection source range must be a non-empty half-open range of non-negative integer offsets.');
    }
}

function assertRevision(revision: number): void {
    if (!Number.isInteger(revision) || revision < 0) {
        throw new RangeError('Projection buffer revision must be a non-negative integer.');
    }
}

function assertCurrentRevision(current: number, received: number): void {
    assertRevision(received);
    if (received !== current) {
        throw new RangeError(
            `Projection result revision ${received} does not match current source revision ${current}.`,
        );
    }
}

function compareSegmentsBySource(a: ProjectionSegment, b: ProjectionSegment): number {
    return a.source.start - b.source.start || a.source.end - b.source.end;
}

function cloneSegment(segment: ProjectionSegment): ProjectionSegment {
    return {
        source: { start: segment.source.start, end: segment.source.end },
        text: segment.text,
        stale: segment.stale,
    };
}
