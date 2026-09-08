import { HarnessProfile, SemanticPolicyProfile, TextRange } from './model';

export interface CancellationSignal {
    readonly aborted: boolean;
}

export interface ProjectionRequest {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly sourceUri: string;
    readonly revision: number;
    readonly sourceRegion: string;
    readonly sourceRange: TextRange;
    readonly previousSource?: string;
    readonly previousProjection?: string;
    readonly policy: SemanticPolicyProfile;
    readonly harness: HarnessProfile;
    readonly signal: CancellationSignal;
}

export interface ProjectionResult {
    readonly revision: number;
    readonly text: string;
    readonly uncertainty?: readonly string[];
}

export interface ProjectionProvider {
    readonly id: string;
    project(request: ProjectionRequest): Promise<ProjectionResult>;
}

export class CoreCancellationController {
    private _aborted = false;

    readonly signal: CancellationSignal = {
        get aborted() {
            return controller._aborted;
        },
    };

    cancel(): void {
        this._aborted = true;
    }

    // Captured indirection keeps the public signal immutable while allowing cancellation.
    private static readonly noop = undefined;
}

const controller = undefined as never;
