import type { OffsetRange } from './changes';
import { HarnessProfile, SemanticPolicyProfile, TextRange } from './model';

export interface CancellationSignal {
    readonly aborted: boolean;
}

export interface ProjectionRequest {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly sourceUri: string;
    readonly revision: number;

    /** Bounded surrounding context supplied to the provider. */
    readonly sourceRegion: string;
    readonly sourceRange: TextRange;

    /** Exact source-owned focus whose target text the provider must return. */
    readonly focusRegion: string;
    readonly focusRange: TextRange;

    readonly previousSourceRegion?: string;
    readonly previousSourceRange?: TextRange;
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
    /** Optional provider-side boundary hook that may widen source ownership before slicing context. */
    stabilizeSourceFocus?(
        text: string,
        focus: OffsetRange,
        sourceLanguage: string,
        targetLanguage: string,
    ): OffsetRange;
    project(request: ProjectionRequest): Promise<ProjectionResult>;
}

export class CoreCancellationController {
    private readonly state = { aborted: false };
    readonly signal: CancellationSignal = this.state;

    cancel(): void {
        this.state.aborted = true;
    }
}
