/**
 * Content-free telemetry contracts for the projection core.
 *
 * These events intentionally carry measurements and identifiers, not raw source,
 * target, prompts, literal payloads, or provider responses. Any opt-in corpus
 * capture is a separate higher-level concern.
 */
export interface ProjectionTelemetryBase {
    readonly revision: number;
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly policyId: string;
    readonly harnessId: string;
}

export interface ProviderTelemetryEvent extends ProjectionTelemetryBase {
    readonly kind: 'provider';
    readonly phase: 'request' | 'result' | 'discarded' | 'error';
    readonly providerId: string;
    readonly sourceCharacters: number;
    readonly focusCharacters: number;
    readonly previousProjectionCharacters?: number;
    readonly outputCharacters?: number;
    readonly durationMs?: number;
}

export interface PatchTelemetryEvent extends ProjectionTelemetryBase {
    readonly kind: 'patch';
    readonly status: 'applied' | 'rejected';
    readonly editCount: number;
    readonly beforeCharacters: number;
    readonly afterCharacters?: number;
    readonly failureCode?: string;
}

export interface ValidationTelemetryEvent extends ProjectionTelemetryBase {
    readonly kind: 'validation';
    readonly validatorId: string;
    readonly status: 'completed' | 'cancelled' | 'error';
    readonly issueCount: number;
    readonly errorCount: number;
    readonly durationMs?: number;
}

export type ProjectionTelemetryEvent =
    | ProviderTelemetryEvent
    | PatchTelemetryEvent
    | ValidationTelemetryEvent;

export interface ProjectionTelemetrySink {
    record(event: ProjectionTelemetryEvent): void | Promise<void>;
}

export const NOOP_PROJECTION_TELEMETRY_SINK: ProjectionTelemetrySink = Object.freeze({
    record(): void {
        // Deliberately empty.
    },
});

export async function recordProjectionTelemetry(
    sink: ProjectionTelemetrySink | undefined,
    event: ProjectionTelemetryEvent,
): Promise<void> {
    await (sink ?? NOOP_PROJECTION_TELEMETRY_SINK).record(event);
}
