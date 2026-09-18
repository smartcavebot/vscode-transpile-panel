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

/**
 * Deliver a telemetry event after rebuilding it from the contract's explicit
 * allow-list. This prevents JavaScript callers or structurally wider TypeScript
 * objects from smuggling raw source/target payloads through extra properties.
 */
export async function recordProjectionTelemetry(
    sink: ProjectionTelemetrySink | undefined,
    event: ProjectionTelemetryEvent,
): Promise<void> {
    await (sink ?? NOOP_PROJECTION_TELEMETRY_SINK).record(sanitizeTelemetryEvent(event));
}

function sanitizeTelemetryEvent(event: ProjectionTelemetryEvent): ProjectionTelemetryEvent {
    const base = {
        revision: event.revision,
        sourceLanguage: event.sourceLanguage,
        targetLanguage: event.targetLanguage,
        policyId: event.policyId,
        harnessId: event.harnessId,
    };

    switch (event.kind) {
        case 'provider':
            return {
                ...base,
                kind: 'provider',
                phase: event.phase,
                providerId: event.providerId,
                sourceCharacters: event.sourceCharacters,
                focusCharacters: event.focusCharacters,
                previousProjectionCharacters: event.previousProjectionCharacters,
                outputCharacters: event.outputCharacters,
                durationMs: event.durationMs,
            };
        case 'patch':
            return {
                ...base,
                kind: 'patch',
                status: event.status,
                editCount: event.editCount,
                beforeCharacters: event.beforeCharacters,
                afterCharacters: event.afterCharacters,
                failureCode: event.failureCode,
            };
        case 'validation':
            return {
                ...base,
                kind: 'validation',
                validatorId: event.validatorId,
                status: event.status,
                issueCount: event.issueCount,
                errorCount: event.errorCount,
                durationMs: event.durationMs,
            };
        default:
            return assertNever(event);
    }
}

function assertNever(value: never): never {
    throw new Error(`Unsupported projection telemetry event kind: ${String((value as { kind?: unknown }).kind)}.`);
}
