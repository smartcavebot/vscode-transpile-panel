import { DocumentSnapshot, HarnessProfile, mergeRanges, ProjectionSlice, SemanticPolicyProfile, TextRange } from './model';
import { CoreCancellationController, ProjectionProvider, ProjectionResult } from './provider';

export interface ProjectionSessionOptions {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly contextLines: number;
    readonly policy: SemanticPolicyProfile;
    readonly harness: HarnessProfile;
}

export class ProjectionSession {
    private revision = 0;
    private dirtyRange?: TextRange;
    private previousSourceRegion?: string;
    private previousSourceRange?: TextRange;
    private previousProjection?: string;
    private cancellation?: CoreCancellationController;

    constructor(private readonly options: ProjectionSessionOptions) {}

    get currentRevision(): number {
        return this.revision;
    }

    invalidate(changedRange?: TextRange): number {
        this.revision += 1;
        this.cancellation?.cancel();
        if (changedRange) {
            this.dirtyRange = mergeRanges(this.dirtyRange, changedRange);
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

        const slice = selectBoundedSlice(document.text, this.dirtyRange, this.options.contextLines);
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
        this.dirtyRange = undefined;
        return result;
    }
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

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
