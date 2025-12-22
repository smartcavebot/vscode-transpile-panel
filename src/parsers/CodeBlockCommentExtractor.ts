/**
 * Extracts and translates comments from code blocks embedded in markdown
 */

import { getLanguageConfig, LanguageConfig } from './LanguagePatterns';
import { CommentExtractor, ExtractedComment } from './CommentExtractor';

// Language aliases for markdown code fence identifiers
const languageAliases: Record<string, string> = {
    'ts': 'typescript',
    'tsx': 'typescript',
    'js': 'javascript',
    'jsx': 'javascript',
    'py': 'python',
    'rb': 'ruby',
    'sh': 'shellscript',
    'bash': 'shellscript',
    'zsh': 'shellscript',
    'cs': 'csharp',
    'yml': 'yaml',
    'c++': 'cpp',
    'h': 'cpp',
    'hpp': 'cpp',
    'rs': 'rust',
    'kt': 'kotlin',
    'kts': 'kotlin',
    'ps1': 'powershell',
    'psm1': 'powershell'
};

// Generic comment patterns for unknown languages (tried in order)
interface GenericPattern {
    name: string;
    single?: RegExp;
    multiStart?: RegExp;
    multiEnd?: RegExp;
}

const genericPatterns: GenericPattern[] = [
    {
        name: 'c-style',
        single: /\/\/.*$/gm,
        multiStart: /\/\*/,
        multiEnd: /\*\//
    },
    {
        name: 'hash',
        single: /#.*$/gm
    },
    {
        name: 'sql',
        single: /--.*$/gm
    },
    {
        name: 'html',
        multiStart: /<!--/,
        multiEnd: /-->/
    }
];

export interface CodeBlockCommentResult {
    language: string;
    originalCode: string;
    codeWithPlaceholders: string;
    comments: {
        text: string;
        placeholder: string;
        fullMatch: string;
        start: number;
        end: number;
    }[];
}

export class CodeBlockCommentExtractor {
    private commentExtractor = new CommentExtractor();
    private placeholderIndex = 0;

    /**
     * Reset placeholder index for new document processing
     */
    resetIndex(): void {
        this.placeholderIndex = 0;
    }

    /**
     * Set starting index for placeholder generation
     */
    setStartIndex(index: number): void {
        this.placeholderIndex = index;
    }

    /**
     * Get current placeholder index
     */
    getCurrentIndex(): number {
        return this.placeholderIndex;
    }

    /**
     * Process a code block and extract comments for translation
     */
    processCodeBlock(code: string, fenceLanguage: string): CodeBlockCommentResult {
        const language = this.resolveLanguage(fenceLanguage);
        const config = getLanguageConfig(language);

        if (config) {
            // Known language - use CommentExtractor
            return this.processWithConfig(code, language, config);
        } else {
            // Unknown language - try generic patterns
            return this.processWithGenericPatterns(code, fenceLanguage);
        }
    }

    /**
     * Rebuild code block with translated comments
     */
    rebuildCodeBlock(result: CodeBlockCommentResult, translatedComments: string[]): string {
        if (result.comments.length === 0) {
            return result.originalCode;
        }

        let code = result.codeWithPlaceholders;

        for (let i = 0; i < result.comments.length; i++) {
            const comment = result.comments[i];
            const translated = translatedComments[i] || comment.text;
            code = code.replace(comment.placeholder, this.formatComment(comment, translated));
        }

        return code;
    }

    private resolveLanguage(fenceLanguage: string): string {
        const lower = fenceLanguage.toLowerCase().trim();
        return languageAliases[lower] || lower;
    }

    private processWithConfig(code: string, language: string, config: LanguageConfig): CodeBlockCommentResult {
        const processed = this.commentExtractor.extract(code, language);
        const comments: CodeBlockCommentResult['comments'] = [];
        let codeWithPlaceholders = code;
        let offset = 0;

        // Sort by position
        const sortedComments = [...processed.comments].sort((a, b) => a.start - b.start);

        for (const comment of sortedComments) {
            // Use non-translatable placeholder format: ⟦§M0§⟧ (M for coMment)
            const placeholder = `⟦§M${this.placeholderIndex++}§⟧`;

            comments.push({
                text: comment.text,
                placeholder,
                fullMatch: comment.fullMatch,
                start: comment.start,
                end: comment.end
            });

            // Replace in code
            const adjustedStart = comment.start + offset;
            const adjustedEnd = comment.end + offset;

            codeWithPlaceholders =
                codeWithPlaceholders.slice(0, adjustedStart) +
                placeholder +
                codeWithPlaceholders.slice(adjustedEnd);

            offset += placeholder.length - comment.fullMatch.length;
        }

        return {
            language,
            originalCode: code,
            codeWithPlaceholders,
            comments
        };
    }

    private processWithGenericPatterns(code: string, fenceLanguage: string): CodeBlockCommentResult {
        // Try each generic pattern until we find comments
        for (const pattern of genericPatterns) {
            const result = this.tryGenericPattern(code, pattern);
            if (result.comments.length > 0) {
                return {
                    ...result,
                    language: fenceLanguage || 'unknown'
                };
            }
        }

        // No comments found with any pattern
        return {
            language: fenceLanguage || 'unknown',
            originalCode: code,
            codeWithPlaceholders: code,
            comments: []
        };
    }

    private tryGenericPattern(code: string, pattern: GenericPattern): Omit<CodeBlockCommentResult, 'language'> {
        const comments: CodeBlockCommentResult['comments'] = [];
        const processedRanges: Array<{ start: number; end: number }> = [];

        // Helper to check if position is already processed
        const isProcessed = (start: number, end: number): boolean => {
            return processedRanges.some(r =>
                (start >= r.start && start < r.end) ||
                (end > r.start && end <= r.end)
            );
        };

        // Extract multi-line comments first
        if (pattern.multiStart && pattern.multiEnd) {
            let searchStart = 0;
            while (searchStart < code.length) {
                const startMatch = code.slice(searchStart).match(pattern.multiStart);
                if (!startMatch || startMatch.index === undefined) break;

                const absoluteStart = searchStart + startMatch.index;
                const afterStart = absoluteStart + startMatch[0].length;
                const endMatch = code.slice(afterStart).match(pattern.multiEnd);

                if (!endMatch || endMatch.index === undefined) {
                    searchStart = afterStart;
                    continue;
                }

                const absoluteEnd = afterStart + endMatch.index + endMatch[0].length;
                const fullMatch = code.slice(absoluteStart, absoluteEnd);
                const innerText = code.slice(afterStart, afterStart + endMatch.index);

                comments.push({
                    text: this.cleanComment(innerText),
                    placeholder: `⟦§M${this.placeholderIndex++}§⟧`,
                    fullMatch,
                    start: absoluteStart,
                    end: absoluteEnd
                });

                processedRanges.push({ start: absoluteStart, end: absoluteEnd });
                searchStart = absoluteEnd;
            }
        }

        // Extract single-line comments
        if (pattern.single) {
            const matches = code.matchAll(pattern.single);
            for (const match of matches) {
                if (match.index !== undefined && !isProcessed(match.index, match.index + match[0].length)) {
                    const text = this.extractCommentText(match[0]);

                    comments.push({
                        text,
                        placeholder: `⟦§M${this.placeholderIndex++}§⟧`,
                        fullMatch: match[0],
                        start: match.index,
                        end: match.index + match[0].length
                    });

                    processedRanges.push({
                        start: match.index,
                        end: match.index + match[0].length
                    });
                }
            }
        }

        // Sort by position
        comments.sort((a, b) => a.start - b.start);

        // Build code with placeholders
        let codeWithPlaceholders = code;
        let offset = 0;

        for (const comment of comments) {
            const adjustedStart = comment.start + offset;
            const adjustedEnd = comment.end + offset;

            codeWithPlaceholders =
                codeWithPlaceholders.slice(0, adjustedStart) +
                comment.placeholder +
                codeWithPlaceholders.slice(adjustedEnd);

            offset += comment.placeholder.length - comment.fullMatch.length;
        }

        return {
            originalCode: code,
            codeWithPlaceholders,
            comments
        };
    }

    private extractCommentText(match: string): string {
        // Remove comment markers
        if (match.startsWith('///')) {
            return match.slice(3).trim();
        } else if (match.startsWith('//')) {
            return match.slice(2).trim();
        } else if (match.startsWith('#')) {
            return match.slice(1).trim();
        } else if (match.startsWith('--')) {
            return match.slice(2).trim();
        }
        return match.trim();
    }

    private cleanComment(text: string): string {
        // Remove leading * from each line (common in block comments)
        const lines = text.split('\n');
        const cleaned = lines.map(line => line.replace(/^\s*\*\s?/, '').trim());
        return cleaned.join('\n').trim();
    }

    private formatComment(comment: CodeBlockCommentResult['comments'][0], translatedText: string): string {
        const fullMatch = comment.fullMatch;

        // Detect comment style and preserve it
        if (fullMatch.startsWith('///')) {
            return `/// ${translatedText}`;
        } else if (fullMatch.startsWith('//')) {
            const hadSpace = fullMatch.startsWith('// ');
            return '//' + (hadSpace ? ' ' : '') + translatedText;
        } else if (fullMatch.startsWith('#')) {
            const hadSpace = fullMatch.startsWith('# ');
            return '#' + (hadSpace ? ' ' : '') + translatedText;
        } else if (fullMatch.startsWith('--')) {
            const hadSpace = fullMatch.startsWith('-- ');
            return '--' + (hadSpace ? ' ' : '') + translatedText;
        } else if (fullMatch.startsWith('/*')) {
            // Multi-line C-style
            if (fullMatch.includes('\n')) {
                const lines = translatedText.split('\n');
                const formatted = lines.map((line, i) => {
                    if (i === 0) return line;
                    return ' * ' + line;
                }).join('\n');
                return `/* ${formatted} */`;
            }
            return `/* ${translatedText} */`;
        } else if (fullMatch.startsWith('<!--')) {
            return `<!-- ${translatedText} -->`;
        }

        return translatedText;
    }
}
