import * as vscode from 'vscode';
import {
    ProjectionCommit,
    ProjectionProvider,
    ProjectionSession,
    TargetProjectionBuffer,
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
        if (!this.matches(event.document)) {
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

    private assertActive(): void {
        if (this.disposed) {
            throw new Error('Projection pair has been disposed.');
        }
    }
}
