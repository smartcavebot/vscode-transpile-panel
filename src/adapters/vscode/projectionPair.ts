import * as vscode from 'vscode';
import {
    OffsetRange,
    ProjectionCommit,
    ProjectionProvider,
    ProjectionSession,
    TargetProjectionBuffer,
    offsetRangeToTextRange,
    selectBoundedSlice,
    textRangeToOffsetRange,
} from '../../core';
import { toCoreChanges, toCoreDocument } from './documentAdapter';
import { ProjectionDocumentProvider, createProjectionUri } from './virtualDocument';

export type ProjectionPairMode = 'pinned' | 'followActive';

export interface ProjectionPairOptions {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly contextLines: number;
    readonly mode: ProjectionPairMode;
}

/**
 * VS Code host binding for one source document and its readonly target projection.
 *
 * Core revision/ownership state stays in ProjectionSession + TargetProjectionBuffer. This class
 * only converts VS Code events/documents and publishes accepted buffer text to the virtual target.
 */
export class VscodeProjectionPair implements vscode.Disposable {
    readonly targetUri: vscode.Uri;
    readonly mode: ProjectionPairMode;

    private readonly session: ProjectionSession;
    private readonly buffer = new TargetProjectionBuffer(0);
    private readonly contextLines: number;
    private initialized = false;
    private disposed = false;

    constructor(
        readonly sourceUri: vscode.Uri,
        readonly targetLanguage: string,
        private readonly provider: ProjectionProvider,
        private readonly documents: ProjectionDocumentProvider,
        options: ProjectionPairOptions,
    ) {
        this.mode = options.mode;
        this.contextLines = options.contextLines;
        this.targetUri = createProjectionUri(sourceUri, targetLanguage);
        this.session = new ProjectionSession({
            sourceLanguage: options.sourceLanguage,
            targetLanguage,
            contextLines: options.contextLines,
            policy: { id: 'default', choices: {} },
            harness: { id: 'none', targetLanguage, facilities: [] },
        });
    }

    matches(document: vscode.TextDocument): boolean {
        return document.uri.toString() === this.sourceUri.toString();
    }

    async initialize(document: vscode.TextDocument): Promise<ProjectionCommit | undefined> {
        this.assertActive();
        if (!this.matches(document)) {
            throw new Error('Projection pair cannot initialize from a different source document.');
        }

        if (!this.initialized) {
            const revision = this.session.invalidate();
            this.buffer.rebase([], revision);
            this.initialized = true;
        }

        return this.refresh(document);
    }

    /**
     * Apply a source mutation immediately without starting provider work.
     *
     * This is the latest-wins boundary: prior work is cancelled by session.invalidate(), target
     * ownership is rebased synchronously, and deterministic deletions are visible before a later
     * debounced/manual refresh runs.
     */
    applySourceChange(event: vscode.TextDocumentChangeEvent): boolean {
        this.assertActive();
        if (!this.matches(event.document) || event.contentChanges.length === 0) {
            return false;
        }

        const changes = toCoreChanges(event);
        const revision = this.session.invalidate(changes);
        this.buffer.rebase(changes, revision);
        this.documents.update(this.targetUri, this.buffer.text);
        return true;
    }

    async refresh(document: vscode.TextDocument): Promise<ProjectionCommit | undefined> {
        this.assertActive();
        if (!this.matches(document)) {
            return undefined;
        }

        this.stabilizeReplacementEnvelope(document);

        const commit = await this.session.refresh(toCoreDocument(document), this.provider);
        if (!commit) {
            return undefined;
        }

        if (commit.sourceOffsets.end > commit.sourceOffsets.start) {
            this.buffer.applyProjection(commit.sourceOffsets, commit.text, commit.revision);
        }
        this.documents.update(this.targetUri, this.buffer.text);
        return commit;
    }

    get targetText(): string {
        return this.buffer.text;
    }

    get hasStaleTarget(): boolean {
        return this.buffer.hasStaleSegments;
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.session.cancelActive();
        this.documents.delete(this.targetUri);
    }

    /**
     * The current core intentionally treats the entire bounded provider slice as source ownership.
     * Therefore a context-expanded slice must never cut through an existing target segment. Widen
     * the pending dirty requirement until the eventual bounded slice either contains or avoids every
     * existing segment. Each iteration absorbs at least one segment, so this terminates in at most
     * segment-count + 1 passes.
     */
    private stabilizeReplacementEnvelope(document: vscode.TextDocument): void {
        const text = document.getText();
        let required = this.session.pendingDirtyOffsets;
        const segments = this.buffer.segments;

        for (let iteration = 0; iteration <= segments.length; iteration += 1) {
            const dirtyRange = required ? offsetRangeToTextRange(text, required) : undefined;
            const planned = textRangeToOffsetRange(
                text,
                selectBoundedSlice(text, dirtyRange, this.contextLines).range,
            );

            let expanded = required;
            let absorbed = false;
            for (const segment of segments) {
                if (
                    rangesOverlap(planned, segment.source) &&
                    !rangeContains(planned, segment.source)
                ) {
                    expanded = unionRanges(expanded, segment.source);
                    absorbed = true;
                }
            }

            if (!absorbed) {
                if (required) {
                    this.session.requireProjectionRange(required);
                }
                return;
            }

            required = expanded;
        }

        throw new Error('Projection replacement envelope did not stabilize.');
    }

    private assertActive(): void {
        if (this.disposed) {
            throw new Error('Projection pair has been disposed.');
        }
    }
}

function rangesOverlap(a: OffsetRange, b: OffsetRange): boolean {
    return a.start < b.end && b.start < a.end;
}

function rangeContains(outer: OffsetRange, inner: OffsetRange): boolean {
    return outer.start <= inner.start && outer.end >= inner.end;
}

function unionRanges(a: OffsetRange | undefined, b: OffsetRange): OffsetRange {
    if (!a) {
        return { start: b.start, end: b.end };
    }
    return {
        start: Math.min(a.start, b.start),
        end: Math.max(a.end, b.end),
    };
}
