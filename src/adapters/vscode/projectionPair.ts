import * as vscode from 'vscode';
import {
    ProjectionCommit,
    ProjectionProvider,
    ProjectionSession,
    TargetProjectionBuffer,
    selectCoverageRequirement,
    stabilizeProjectionRequirement,
} from '../../core';
import { toCoreChanges, toCoreDocument } from './documentAdapter';
import { ProjectionDocumentProvider, createProjectionUri } from './virtualDocument';

export type ProjectionPairMode = 'pinned' | 'followActive';

export interface ProjectionPairOptions {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly contextLines: number;
    readonly maxContextCharacters: number;
    readonly coverageChunkLines: number;
    readonly coverageChunkCharacters: number;
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
    private readonly coverageChunkLines: number;
    private readonly coverageChunkCharacters: number;
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
        this.coverageChunkLines = positiveInteger(
            options.coverageChunkLines,
            'coverage chunk lines',
        );
        this.coverageChunkCharacters = positiveInteger(
            options.coverageChunkCharacters,
            'coverage chunk characters',
        );
        this.targetUri = createProjectionUri(sourceUri, targetLanguage);
        this.session = new ProjectionSession({
            sourceLanguage: options.sourceLanguage,
            targetLanguage,
            contextLines: Math.max(0, options.contextLines),
            maxContextCharacters: positiveInteger(
                options.maxContextCharacters,
                'maximum context characters',
            ),
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

        return this.fillCoverage(document);
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

        let accepted: ProjectionCommit | undefined;
        if (this.session.pendingDirtyOffsets) {
            accepted = await this.refreshPendingFocus(document);
            if (!accepted) {
                return undefined;
            }
        }

        return (await this.fillCoverage(document)) ?? accepted;
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

    private async refreshPendingFocus(
        document: vscode.TextDocument,
    ): Promise<ProjectionCommit | undefined> {
        const sourceText = document.getText();
        const required = stabilizeProjectionRequirement(
            sourceText,
            this.session.pendingDirtyOffsets,
            this.buffer.segments.map((segment) => segment.source),
        );
        if (required) {
            this.session.requireProjectionRange(required);
        }

        const commit = await this.session.refresh(toCoreDocument(document), this.provider);
        if (!commit) {
            return undefined;
        }

        this.applyCommit(commit);
        return commit;
    }

    /**
     * Fill every uncovered source span using independently bounded focus requests.
     *
     * Provider context may overlap earlier segments, but only the selected coverage requirement
     * owns target text. Each accepted commit must strictly shrink the first coverage gap; otherwise
     * the loop aborts rather than hiding a non-progressing provider/session bug.
     */
    private async fillCoverage(
        document: vscode.TextDocument,
    ): Promise<ProjectionCommit | undefined> {
        const sourceText = document.getText();
        const sourceLength = sourceText.length;
        if (sourceLength === 0) {
            this.documents.update(this.targetUri, '');
            return undefined;
        }

        let lastAccepted: ProjectionCommit | undefined;
        while (true) {
            const gaps = this.buffer.coverageGaps(sourceLength);
            const gap = gaps[0];
            if (!gap) {
                return lastAccepted;
            }

            const requested = selectCoverageRequirement(
                sourceText,
                gap,
                this.coverageChunkLines,
                this.coverageChunkCharacters,
            );
            const required = stabilizeProjectionRequirement(
                sourceText,
                requested,
                this.buffer.segments.map((segment) => segment.source),
            );
            if (!required) {
                throw new Error('Coverage selection produced no projection focus.');
            }

            this.session.requireProjectionRange(required);
            const commit = await this.session.refresh(toCoreDocument(document), this.provider);
            if (!commit) {
                return lastAccepted;
            }

            this.applyCommit(commit);
            lastAccepted = commit;

            const nextGap = this.buffer.coverageGaps(sourceLength)[0];
            if (
                nextGap &&
                nextGap.start === gap.start &&
                nextGap.end === gap.end
            ) {
                throw new Error('Bounded projection coverage made no source-ownership progress.');
            }
        }
    }

    private applyCommit(commit: ProjectionCommit): void {
        if (commit.sourceOffsets.end > commit.sourceOffsets.start) {
            this.buffer.applyProjection(commit.sourceOffsets, commit.text, commit.revision);
        }
        this.documents.update(this.targetUri, this.buffer.text);
    }

    private assertActive(): void {
        if (this.disposed) {
            throw new Error('Projection pair has been disposed.');
        }
    }
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive integer.`);
    }
    return value;
}
