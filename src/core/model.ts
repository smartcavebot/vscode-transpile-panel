export interface TextPosition {
    readonly line: number;
    readonly character: number;
}

export interface TextRange {
    readonly start: TextPosition;
    readonly end: TextPosition;
}

export interface TextChange {
    readonly range: TextRange;
    readonly rangeOffset: number;
    readonly rangeLength: number;
    readonly text: string;
}

export interface DocumentSnapshot {
    readonly uri: string;
    readonly languageId: string;
    readonly version: number;
    readonly text: string;
}

export interface SemanticPolicyProfile {
    readonly id: string;
    readonly choices: Readonly<Record<string, string>>;
}

export interface HarnessProfile {
    readonly id: string;
    readonly targetLanguage: string;
    readonly facilities: readonly string[];
}

export interface ProjectionSlice {
    readonly text: string;
    readonly range: TextRange;
}

export function mergeRanges(a: TextRange | undefined, b: TextRange): TextRange {
    if (!a) {
        return b;
    }

    return {
        start: comparePositions(a.start, b.start) <= 0 ? a.start : b.start,
        end: comparePositions(a.end, b.end) >= 0 ? a.end : b.end,
    };
}

function comparePositions(a: TextPosition, b: TextPosition): number {
    if (a.line !== b.line) {
        return a.line - b.line;
    }
    return a.character - b.character;
}
