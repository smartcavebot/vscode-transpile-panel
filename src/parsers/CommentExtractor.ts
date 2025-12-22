import { getLanguageConfig, isPlainTextLanguage, LanguageConfig } from './LanguagePatterns';

export interface ExtractedComment {
    text: string;           // Comment text (without markers)
    fullMatch: string;      // Full matched string including markers
    start: number;          // Start index in original text
    end: number;            // End index in original text
    type: 'single' | 'multi' | 'doc';
    prefix: string;         // Comment marker prefix (e.g., "//", "/*", "#")
    suffix: string;         // Comment marker suffix (e.g., "*/", "")
    indent: string;         // Leading whitespace
}

export interface ProcessedContent {
    originalText: string;
    comments: ExtractedComment[];
    isCodeFile: boolean;
}

export class CommentExtractor {
    /**
     * Extract comments from source code based on language
     */
    extract(text: string, languageId: string): ProcessedContent {
        // Plain text files - translate everything
        if (isPlainTextLanguage(languageId)) {
            return {
                originalText: text,
                comments: [],
                isCodeFile: false
            };
        }

        const config = getLanguageConfig(languageId);
        if (!config) {
            // Unknown language - treat as plain text
            return {
                originalText: text,
                comments: [],
                isCodeFile: false
            };
        }

        const comments = this.extractComments(text, config);

        return {
            originalText: text,
            comments,
            isCodeFile: true
        };
    }

    /**
     * Rebuild source with translated comments
     */
    rebuild(processed: ProcessedContent, translatedComments: string[]): string {
        if (!processed.isCodeFile) {
            // Plain text - return translated content directly
            return translatedComments[0] || processed.originalText;
        }

        if (processed.comments.length === 0) {
            return processed.originalText;
        }

        let result = processed.originalText;
        let offset = 0;

        // Sort by position and replace in order
        const sortedComments = [...processed.comments].sort((a, b) => a.start - b.start);

        for (let i = 0; i < sortedComments.length; i++) {
            const comment = sortedComments[i];
            const translated = translatedComments[i] || comment.text;

            // Rebuild the comment with original markers
            const newComment = this.rebuildComment(comment, translated);

            const adjustedStart = comment.start + offset;
            const adjustedEnd = comment.end + offset;

            result = result.slice(0, adjustedStart) + newComment + result.slice(adjustedEnd);

            offset += newComment.length - comment.fullMatch.length;
        }

        return result;
    }

    /**
     * Get only the comment texts for translation
     */
    getTextsForTranslation(processed: ProcessedContent): string[] {
        if (!processed.isCodeFile) {
            return [processed.originalText];
        }

        return processed.comments.map(c => c.text);
    }

    private extractComments(text: string, config: LanguageConfig): ExtractedComment[] {
        const comments: ExtractedComment[] = [];
        const processedRanges: Array<{ start: number; end: number }> = [];

        // Helper to check if position is already processed
        const isProcessed = (start: number, end: number): boolean => {
            return processedRanges.some(r =>
                (start >= r.start && start < r.end) ||
                (end > r.start && end <= r.end)
            );
        };

        // Extract doc blocks first (highest priority)
        if (config.patterns.docBlock) {
            const docMatches = text.matchAll(config.patterns.docBlock);
            for (const match of docMatches) {
                if (match.index !== undefined && !isProcessed(match.index, match.index + match[0].length)) {
                    const extracted = this.parseDocBlock(match[0], match.index, config);
                    if (extracted) {
                        comments.push(extracted);
                        processedRanges.push({ start: match.index, end: match.index + match[0].length });
                    }
                }
            }
        }

        // Extract multi-line comments
        if (config.patterns.multiStart && config.patterns.multiEnd) {
            const multiComments = this.extractMultiLineComments(text, config, processedRanges);
            comments.push(...multiComments);
        }

        // Extract single-line comments
        if (config.patterns.single) {
            const singleMatches = text.matchAll(config.patterns.single);
            for (const match of singleMatches) {
                if (match.index !== undefined && !isProcessed(match.index, match.index + match[0].length)) {
                    const extracted = this.parseSingleLineComment(match[0], match.index, text, config);
                    if (extracted) {
                        comments.push(extracted);
                        processedRanges.push({ start: match.index, end: match.index + match[0].length });
                    }
                }
            }
        }

        // Sort by position
        return comments.sort((a, b) => a.start - b.start);
    }

    private extractMultiLineComments(
        text: string,
        config: LanguageConfig,
        processedRanges: Array<{ start: number; end: number }>
    ): ExtractedComment[] {
        const comments: ExtractedComment[] = [];
        const startPattern = config.patterns.multiStart!;
        const endPattern = config.patterns.multiEnd!;

        let searchStart = 0;
        while (searchStart < text.length) {
            const startMatch = text.slice(searchStart).match(startPattern);
            if (!startMatch || startMatch.index === undefined) break;

            const absoluteStart = searchStart + startMatch.index;

            // Check if already processed
            if (processedRanges.some(r => absoluteStart >= r.start && absoluteStart < r.end)) {
                searchStart = absoluteStart + 1;
                continue;
            }

            const afterStart = absoluteStart + startMatch[0].length;
            const endMatch = text.slice(afterStart).match(endPattern);

            if (!endMatch || endMatch.index === undefined) {
                searchStart = afterStart;
                continue;
            }

            const absoluteEnd = afterStart + endMatch.index + endMatch[0].length;
            const fullMatch = text.slice(absoluteStart, absoluteEnd);
            const innerText = text.slice(afterStart, afterStart + endMatch.index);

            // Get indent
            const lineStart = text.lastIndexOf('\n', absoluteStart - 1) + 1;
            const indent = text.slice(lineStart, absoluteStart).match(/^\s*/)?.[0] || '';

            comments.push({
                text: this.cleanMultiLineComment(innerText),
                fullMatch,
                start: absoluteStart,
                end: absoluteEnd,
                type: 'multi',
                prefix: startMatch[0],
                suffix: endMatch[0],
                indent
            });

            processedRanges.push({ start: absoluteStart, end: absoluteEnd });
            searchStart = absoluteEnd;
        }

        return comments;
    }

    private parseSingleLineComment(
        match: string,
        index: number,
        fullText: string,
        config: LanguageConfig
    ): ExtractedComment | null {
        // Detect comment marker
        let prefix = '';
        let text = match;

        if (match.startsWith('///')) {
            prefix = '///';
            text = match.slice(3);
        } else if (match.startsWith('//')) {
            prefix = '//';
            text = match.slice(2);
        } else if (match.startsWith('#')) {
            prefix = '#';
            text = match.slice(1);
        } else if (match.startsWith('--')) {
            prefix = '--';
            text = match.slice(2);
        }

        // Get indent
        const lineStart = fullText.lastIndexOf('\n', index - 1) + 1;
        const indent = fullText.slice(lineStart, index).match(/^\s*/)?.[0] || '';

        return {
            text: text.trim(),
            fullMatch: match,
            start: index,
            end: index + match.length,
            type: 'single',
            prefix,
            suffix: '',
            indent
        };
    }

    private parseDocBlock(
        match: string,
        index: number,
        config: LanguageConfig
    ): ExtractedComment | null {
        let prefix = '';
        let suffix = '';
        let text = match;

        if (match.startsWith('/**')) {
            prefix = '/**';
            suffix = '*/';
            text = match.slice(3, -2);
        } else if (match.startsWith('///')) {
            prefix = '///';
            text = match.slice(3);
        } else if (match.startsWith('//!')) {
            prefix = '//!';
            text = match.slice(3);
        } else if (match.startsWith('"""') || match.startsWith("'''")) {
            prefix = match.slice(0, 3);
            suffix = prefix;
            text = match.slice(3, -3);
        }

        return {
            text: this.cleanMultiLineComment(text),
            fullMatch: match,
            start: index,
            end: index + match.length,
            type: 'doc',
            prefix,
            suffix,
            indent: ''
        };
    }

    private cleanMultiLineComment(text: string): string {
        // Remove leading * from each line (common in JSDoc/JavaDoc)
        const lines = text.split('\n');
        const cleaned = lines.map(line => {
            const trimmed = line.replace(/^\s*\*\s?/, '');
            return trimmed;
        });
        return cleaned.join('\n').trim();
    }

    private rebuildComment(comment: ExtractedComment, translatedText: string): string {
        if (comment.type === 'single') {
            // Preserve space after marker if original had it
            const hadSpace = comment.fullMatch.startsWith(comment.prefix + ' ');
            return comment.prefix + (hadSpace ? ' ' : '') + translatedText;
        }

        if (comment.type === 'multi' || comment.type === 'doc') {
            // For multi-line, preserve formatting
            const lines = translatedText.split('\n');

            if (comment.prefix === '/**' || comment.prefix === '/*') {
                // JSDoc/block comment style
                if (lines.length === 1) {
                    return `${comment.prefix} ${translatedText} ${comment.suffix}`;
                }

                const formatted = lines.map((line, i) => {
                    if (i === 0) return line;
                    return ` * ${line}`;
                }).join('\n');

                return `${comment.prefix}\n * ${formatted}\n ${comment.suffix}`;
            }

            // Simple multi-line
            return `${comment.prefix}${translatedText}${comment.suffix}`;
        }

        return comment.fullMatch;
    }
}
