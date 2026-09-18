export interface GroundedPatchEdit {
    readonly search: string;
    readonly replace: string;
}

export interface GroundedPatch {
    /** Source/projection revision this patch was produced against. */
    readonly revision: number;
    /**
     * Exact SEARCH/REPLACE edits applied sequentially.
     *
     * Every search anchor must match exactly once in the text produced by the
     * preceding edit. Regex and fuzzy matching are deliberately excluded.
     */
    readonly edits: readonly GroundedPatchEdit[];
}

export type GroundedPatchFailureCode =
    | 'invalid-revision'
    | 'revision-mismatch'
    | 'empty-search'
    | 'missing-anchor'
    | 'ambiguous-anchor';

export class GroundedPatchError extends Error {
    constructor(
        readonly code: GroundedPatchFailureCode,
        message: string,
        readonly editIndex?: number,
    ) {
        super(message);
        this.name = 'GroundedPatchError';
    }
}

export interface GroundedPatchApplyResult {
    readonly revision: number;
    readonly text: string;
    readonly appliedEdits: number;
}

/**
 * Apply a provider-produced patch only when every edit is grounded by a unique,
 * exact anchor in the current target text.
 *
 * Edits are intentionally sequential: later SEARCH anchors are evaluated
 * against the text produced by earlier edits. This makes stale or ambiguous
 * provider output fail closed instead of silently applying in the wrong place.
 */
export function applyGroundedPatch(
    currentText: string,
    currentRevision: number,
    patch: GroundedPatch,
): GroundedPatchApplyResult {
    assertRevision(currentRevision, 'current revision');
    assertRevision(patch.revision, 'patch revision');

    if (patch.revision !== currentRevision) {
        throw new GroundedPatchError(
            'revision-mismatch',
            `Grounded patch revision ${patch.revision} does not match current revision ${currentRevision}.`,
        );
    }

    let text = currentText;
    patch.edits.forEach((edit, editIndex) => {
        if (edit.search.length === 0) {
            throw new GroundedPatchError(
                'empty-search',
                `Grounded patch edit ${editIndex} has an empty SEARCH anchor.`,
                editIndex,
            );
        }

        const first = text.indexOf(edit.search);
        if (first < 0) {
            throw new GroundedPatchError(
                'missing-anchor',
                `Grounded patch edit ${editIndex} SEARCH anchor is not present in the current target text.`,
                editIndex,
            );
        }

        // Start one character after the first match so overlapping duplicate
        // anchors are treated as ambiguous too.
        const second = text.indexOf(edit.search, first + 1);
        if (second >= 0) {
            throw new GroundedPatchError(
                'ambiguous-anchor',
                `Grounded patch edit ${editIndex} SEARCH anchor matches more than once.`,
                editIndex,
            );
        }

        text =
            text.slice(0, first) +
            edit.replace +
            text.slice(first + edit.search.length);
    });

    return {
        revision: currentRevision,
        text,
        appliedEdits: patch.edits.length,
    };
}

function assertRevision(value: number, label: string): void {
    if (!Number.isInteger(value) || value < 0) {
        throw new GroundedPatchError(
            'invalid-revision',
            `${label} must be a non-negative integer; received ${value}.`,
        );
    }
}
