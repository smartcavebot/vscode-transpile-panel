import type { OffsetRange } from './changes';
import type { HarnessProfile, SemanticPolicyProfile } from './model';
import type { CancellationSignal } from './provider';

export type ProjectionValidationSeverity = 'error' | 'warning' | 'info';

export interface ProjectionValidationIssue {
    readonly code: string;
    readonly message: string;
    readonly severity: ProjectionValidationSeverity;
    /** Optional target-text offsets; host adapters may map these to native ranges. */
    readonly range?: OffsetRange;
}

export interface ProjectionValidationRequest {
    readonly revision: number;
    readonly targetLanguage: string;
    readonly text: string;
    readonly policy: SemanticPolicyProfile;
    readonly harness: HarnessProfile;
    readonly signal: CancellationSignal;
}

export interface ProjectionValidationResult {
    readonly validatorId: string;
    readonly issues: readonly ProjectionValidationIssue[];
}

export interface ProjectionValidator {
    readonly id: string;
    validate(request: ProjectionValidationRequest): Promise<ProjectionValidationResult>;
}

export interface ProjectionValidationBatchResult {
    readonly revision: number;
    readonly results: readonly ProjectionValidationResult[];
    readonly cancelled: boolean;
    readonly hasErrors: boolean;
}

/**
 * Run host-neutral validators in deterministic order.
 *
 * Runtime/process discovery belongs to a host adapter or validator
 * implementation. The core only coordinates the contract and validates that
 * returned ranges are safe for the supplied target text.
 */
export async function runProjectionValidators(
    validators: readonly ProjectionValidator[],
    request: ProjectionValidationRequest,
): Promise<ProjectionValidationBatchResult> {
    assertRevision(request.revision);
    const results: ProjectionValidationResult[] = [];

    for (const validator of validators) {
        if (request.signal.aborted) {
            return batchResult(request.revision, results, true);
        }

        const result = await validator.validate(request);
        if (result.validatorId !== validator.id) {
            throw new Error(
                `Projection validator "${validator.id}" returned result for "${result.validatorId}".`,
            );
        }
        validateIssues(result.issues, request.text.length, validator.id);
        results.push({
            validatorId: result.validatorId,
            issues: result.issues.map(cloneIssue),
        });

        if (request.signal.aborted) {
            return batchResult(request.revision, results, true);
        }
    }

    return batchResult(request.revision, results, false);
}

function batchResult(
    revision: number,
    results: readonly ProjectionValidationResult[],
    cancelled: boolean,
): ProjectionValidationBatchResult {
    return {
        revision,
        results,
        cancelled,
        hasErrors: results.some((result) =>
            result.issues.some((issue) => issue.severity === 'error'),
        ),
    };
}

function validateIssues(
    issues: readonly ProjectionValidationIssue[],
    textLength: number,
    validatorId: string,
): void {
    for (const issue of issues) {
        if (!issue.code || !issue.message) {
            throw new Error(
                `Projection validator "${validatorId}" returned an issue without code/message.`,
            );
        }
        if (!['error', 'warning', 'info'].includes(issue.severity)) {
            throw new Error(
                `Projection validator "${validatorId}" returned invalid severity "${String(issue.severity)}".`,
            );
        }
        if (issue.range) {
            if (
                !Number.isInteger(issue.range.start) ||
                !Number.isInteger(issue.range.end) ||
                issue.range.start < 0 ||
                issue.range.end < issue.range.start ||
                issue.range.end > textLength
            ) {
                throw new RangeError(
                    `Projection validator "${validatorId}" returned an invalid target range.`,
                );
            }
        }
    }
}

function cloneIssue(issue: ProjectionValidationIssue): ProjectionValidationIssue {
    return {
        code: issue.code,
        message: issue.message,
        severity: issue.severity,
        range: issue.range
            ? { start: issue.range.start, end: issue.range.end }
            : undefined,
    };
}

function assertRevision(revision: number): void {
    if (!Number.isInteger(revision) || revision < 0) {
        throw new RangeError('Projection validation revision must be a non-negative integer.');
    }
}
