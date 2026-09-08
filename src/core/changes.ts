import { TextChange } from './model';

export interface OffsetRange {
    readonly start: number;
    readonly end: number;
}

export function normalizeTextChanges(changes: readonly TextChange[]): readonly TextChange[] {
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

/**
 * Rebase a pending dirty span through a later revision.
 *
 * Insertions at the dirty span's start are kept outside the old span so the caller
 * can union the insertion's own changed range back in. This preserves the complete
 * dirty envelope without double-assigning insertion boundaries.
 */
export function rebaseDirtyOffsetRange(
    range: OffsetRange,
    changes: readonly TextChange[],
): OffsetRange {
    const normalizedChanges = normalizeTextChanges(changes);
    const start = mapDirtyOffset(range.start, normalizedChanges, 'start');
    const end = mapDirtyOffset(range.end, normalizedChanges, 'end');

    return start <= end
        ? { start, end }
        : { start: end, end: start };
}

/**
 * Rebase a source-owned half-open range through edits.
 *
 * Insertions exactly at the start belong to the following range; insertions exactly
 * at the end do not. Replacements that consume a boundary expand a touched range to
 * the replacement span. The result is suitable for long-lived source anchors.
 */
export function rebaseTrackedOffsetRange(
    range: OffsetRange,
    changes: readonly TextChange[],
): OffsetRange {
    const normalizedChanges = normalizeTextChanges(changes);
    const start = mapTrackedOffset(range.start, normalizedChanges, 'start');
    const end = mapTrackedOffset(range.end, normalizedChanges, 'end');

    return start <= end
        ? { start, end }
        : { start: end, end: start };
}

export function changedOffsetsAfterEdits(
    changes: readonly TextChange[],
): OffsetRange | undefined {
    const normalizedChanges = normalizeTextChanges(changes);
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

export function changeTouchesTrackedRange(range: OffsetRange, change: TextChange): boolean {
    if (change.rangeLength === 0) {
        return range.start <= change.rangeOffset && change.rangeOffset < range.end;
    }

    const changeEnd = change.rangeOffset + change.rangeLength;
    return change.rangeOffset < range.end && changeEnd > range.start;
}

export function unionOffsetRanges(
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

export function rangesOverlap(a: OffsetRange, b: OffsetRange): boolean {
    return a.start < b.end && b.start < a.end;
}

export function rangeContains(outer: OffsetRange, inner: OffsetRange): boolean {
    return outer.start <= inner.start && inner.end <= outer.end;
}

function mapDirtyOffset(
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

function mapTrackedOffset(
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

        if (change.rangeLength === 0) {
            if (offset === oldStart) {
                return newStart;
            }
            cumulativeDelta += change.text.length;
            continue;
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
