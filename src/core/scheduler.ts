import { DocumentSnapshot, TextChange } from './model';
import { ProjectionProvider } from './provider';
import { ProjectionCommit, ProjectionSession } from './session';

export type ProjectionRefreshMode = 'manual' | 'debounced' | 'semantic';

export interface SchedulerClock {
    set(delayMs: number, callback: () => void): unknown;
    clear(handle: unknown): void;
}

export interface ProjectionRefreshSchedulerOptions {
    readonly mode: ProjectionRefreshMode;
    readonly debounceMs: number;
    readonly clock?: SchedulerClock;
    readonly onResult?: (result: ProjectionCommit) => void;
    readonly onError?: (error: unknown) => void;
}

const systemClock: SchedulerClock = {
    set(delayMs, callback) {
        return setTimeout(callback, delayMs);
    },
    clear(handle) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
};

/**
 * Host-neutral policy for deciding when an invalidated projection session refreshes.
 *
 * Source mutation and refresh timing are deliberately separate concerns: every real
 * text mutation invalidates in-flight work immediately, while the selected mode
 * decides when the next provider request is allowed to begin.
 */
export class ProjectionRefreshScheduler {
    private mode: ProjectionRefreshMode;
    private readonly debounceMs: number;
    private readonly clock: SchedulerClock;
    private latestDocument?: DocumentSnapshot;
    private timer?: unknown;
    private disposed = false;

    constructor(
        private readonly session: ProjectionSession,
        private readonly provider: ProjectionProvider,
        options: ProjectionRefreshSchedulerOptions,
    ) {
        this.mode = options.mode;
        this.debounceMs = Math.max(0, options.debounceMs);
        this.clock = options.clock ?? systemClock;
        this.onResult = options.onResult;
        this.onError = options.onError;
    }

    private readonly onResult?: (result: ProjectionCommit) => void;
    private readonly onError?: (error: unknown) => void;

    get currentMode(): ProjectionRefreshMode {
        return this.mode;
    }

    get hasPendingRefresh(): boolean {
        return this.timer !== undefined;
    }

    onDocumentChanged(
        document: DocumentSnapshot,
        changes: readonly TextChange[],
    ): void {
        this.assertActive();
        this.latestDocument = document;

        // VS Code and other hosts may publish document-change events that contain no
        // textual edits. Those should update the snapshot but must not create a new
        // projection revision or cancel valid work.
        if (changes.length === 0) {
            return;
        }

        this.session.invalidate(changes);

        if (this.mode === 'debounced') {
            this.scheduleDebouncedRefresh();
        }
    }

    async refreshNow(document?: DocumentSnapshot): Promise<ProjectionCommit | undefined> {
        this.assertActive();
        if (document) {
            this.latestDocument = document;
        }

        this.clearPendingRefresh();
        const current = this.latestDocument;
        if (!current) {
            return undefined;
        }

        const result = await this.session.refresh(current, this.provider);
        if (result) {
            this.onResult?.(result);
        }
        return result;
    }

    async onSemanticEvent(document?: DocumentSnapshot): Promise<ProjectionCommit | undefined> {
        this.assertActive();
        if (document) {
            this.latestDocument = document;
        }
        if (this.mode !== 'semantic') {
            return undefined;
        }
        return this.refreshNow();
    }

    setMode(mode: ProjectionRefreshMode): void {
        this.assertActive();
        if (mode === this.mode) {
            return;
        }

        this.clearPendingRefresh();
        this.mode = mode;
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.clearPendingRefresh();
        this.session.cancelActive();
        this.disposed = true;
    }

    private scheduleDebouncedRefresh(): void {
        this.clearPendingRefresh();
        this.timer = this.clock.set(this.debounceMs, () => {
            this.timer = undefined;
            void this.refreshNow().catch((error) => {
                this.onError?.(error);
            });
        });
    }

    private clearPendingRefresh(): void {
        if (this.timer === undefined) {
            return;
        }
        this.clock.clear(this.timer);
        this.timer = undefined;
    }

    private assertActive(): void {
        if (this.disposed) {
            throw new Error('ProjectionRefreshScheduler has been disposed.');
        }
    }
}
