import {
    ProjectionProvider,
    ProjectionRequest,
    ProjectionResult,
} from '../core';

/**
 * Temporary provider used only to exercise the projection runtime before a real LM/local
 * translation provider is selected. It deliberately makes no semantic claim: only the exact
 * requested focus is echoed unchanged and marked uncertain. Surrounding provider context is
 * advisory and never becomes target ownership.
 */
export class ScaffoldProjectionProvider implements ProjectionProvider {
    readonly id = 'scaffold-passthrough';

    async project(request: ProjectionRequest): Promise<ProjectionResult> {
        if (request.signal.aborted) {
            return {
                revision: request.revision,
                text: '',
                uncertainty: ['projection cancelled before scaffold provider execution'],
            };
        }

        return {
            revision: request.revision,
            text: request.focusRegion,
            uncertainty: [
                'Scaffold provider only: focus fragment is echoed without semantic translation.',
            ],
        };
    }
}
