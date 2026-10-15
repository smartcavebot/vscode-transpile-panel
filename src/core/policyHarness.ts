import type { HarnessProfile, SemanticPolicyProfile } from './model';

/** A target-language choice, not an implicit model preference. */
export interface SemanticChoiceDefinition {
    readonly id: string;
    readonly values: readonly string[];
    readonly defaultValue: string;
}

export interface SemanticPolicySchema {
    readonly id: string;
    readonly choices: readonly SemanticChoiceDefinition[];
}

/** Named support code is separate from source-owned target projection segments. */
export interface HarnessFacility {
    readonly id: string;
    readonly targetLanguage: string;
    readonly text: string;
}

export interface HarnessSection {
    readonly kind: 'harness';
    readonly facilityId: string;
    readonly text: string;
}

export interface TranslatedSection {
    readonly kind: 'translation';
    readonly text: string;
}

export type TargetSection = HarnessSection | TranslatedSection;

export function resolveSemanticPolicy(
    schema: SemanticPolicySchema,
    overrides: Readonly<Record<string, string>> = {},
): SemanticPolicyProfile {
    const definitions = new Map<string, SemanticChoiceDefinition>();
    const choices: Record<string, string> = {};
    if (!schema.id.trim()) throw new Error('Semantic policy schema must have an id.');
    for (const definition of schema.choices) {
        if (!definition.id || definitions.has(definition.id) ||
            definition.values.length === 0 ||
            new Set(definition.values).size !== definition.values.length ||
            !definition.values.includes(definition.defaultValue)) {
            throw new Error(`Invalid semantic choice definition: ${definition.id}.`);
        }
        definitions.set(definition.id, definition);
        choices[definition.id] = definition.defaultValue;
    }
    for (const [id, value] of Object.entries(overrides)) {
        const definition = definitions.get(id);
        if (!definition || !definition.values.includes(value)) {
            throw new Error(`Unknown semantic choice/value: ${id}=${value}.`);
        }
        choices[id] = value;
    }
    return { id: schema.id, choices };
}

export function resolveHarnessSections(
    profile: HarnessProfile,
    available: readonly HarnessFacility[],
): readonly HarnessSection[] {
    const byId = new Map<string, HarnessFacility>();
    for (const facility of available) {
        if (!facility.id || byId.has(facility.id)) {
            throw new Error(`Duplicate or empty harness facility: ${facility.id}.`);
        }
        byId.set(facility.id, facility);
    }
    const used = new Set<string>();
    return profile.facilities.map((id) => {
        if (used.has(id)) throw new Error(`Duplicate requested harness facility: ${id}.`);
        used.add(id);
        const facility = byId.get(id);
        if (!facility || facility.targetLanguage !== profile.targetLanguage) {
            throw new Error(`Unavailable harness facility for ${profile.targetLanguage}: ${id}.`);
        }
        return { kind: 'harness' as const, facilityId: id, text: facility.text };
    });
}

/** Typed provenance is retained even if a host renders the sections in one document. */
export function composeTargetSections(
    targetText: string,
    harness: readonly HarnessSection[],
): readonly TargetSection[] {
    return [...harness, { kind: 'translation', text: targetText }];
}
