/**
 * Content processor for languages that need selective translation
 * (e.g., Markdown - translate text but preserve code blocks)
 */

import { CodeBlockCommentExtractor, CodeBlockCommentResult } from './CodeBlockCommentExtractor';

export interface ProtectedRegion {
    start: number;
    end: number;
    content: string;
    placeholder: string;
    // Extended fields for code blocks with comments
    language?: string;
    codeBlockData?: CodeBlockCommentResult;
}

export interface ProcessedText {
    text: string;                    // Text with placeholders
    regions: ProtectedRegion[];      // Protected regions to restore
}

export interface EnhancedProcessedText extends ProcessedText {
    codeBlockComments: string[];     // Comment texts from code blocks to translate
    commentMapping: Map<string, { blockIndex: number; commentIndex: number }>;
}

export abstract class ContentProcessor {
    abstract readonly languageId: string;

    /**
     * Extract protected regions and replace with placeholders
     */
    abstract process(text: string): ProcessedText;

    /**
     * Restore protected regions from placeholders
     */
    restore(translated: string, regions: ProtectedRegion[]): string {
        let result = translated;

        // Sort by placeholder to ensure consistent replacement
        const sortedRegions = [...regions].sort((a, b) =>
            b.placeholder.localeCompare(a.placeholder)
        );

        for (const region of sortedRegions) {
            result = result.replace(region.placeholder, region.content);
        }

        return result;
    }

    /**
     * Create a placeholder that won't be translated
     * Uses alphanumeric codes instead of English words to prevent translation
     */
    protected createPlaceholder(index: number, type: string): string {
        // Map type names to short non-translatable codes
        const typeMap: Record<string, string> = {
            'CODE': 'C',
            'INLINE': 'I',
            'INDENT': 'D',
            'URL': 'U',
            'IMG': 'G',
            'REF': 'R',
            'HTML': 'H',
            'KEY': 'K',
            'VAL': 'V',
            'SCRIPT': 'S',
            'STYLE': 'Y',
            'TAG': 'T',
            'TABLE': 'A'    // Markdown table (entire structure)
        };
        const code = typeMap[type] || type.charAt(0);
        // Format: ⟦§X0§⟧ where X is type code, 0 is index
        // Using § symbols to further prevent translation
        return `⟦§${code}${index}§⟧`;
    }
}

/**
 * Markdown processor - protects code blocks, inline code, URLs
 */
export class MarkdownProcessor extends ContentProcessor {
    readonly languageId = 'markdown';

    process(text: string): ProcessedText {
        const regions: ProtectedRegion[] = [];
        let result = text;
        let index = 0;

        // Order matters: process larger patterns first

        // 1. Fenced code blocks: ```lang\n...\n```
        result = result.replace(/```[\w-]*\n[\s\S]*?\n```/g, (match, offset) => {
            const placeholder = this.createPlaceholder(index++, 'CODE');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        // 2. Indented code blocks (4 spaces or 1 tab at line start)
        result = result.replace(/(?:^|\n)((?:[ ]{4}|\t).+(?:\n(?:[ ]{4}|\t).+)*)/g, (match, code, offset) => {
            const placeholder = this.createPlaceholder(index++, 'INDENT');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        // 3. Inline code: `code`
        result = result.replace(/`[^`\n]+`/g, (match, offset) => {
            const placeholder = this.createPlaceholder(index++, 'INLINE');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        // 4. Links: [text](url) - protect URL part only
        result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url, offset) => {
            const urlPlaceholder = this.createPlaceholder(index++, 'URL');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: url,
                placeholder: urlPlaceholder
            });
            return `[${text}](${urlPlaceholder})`;
        });

        // 5. Images: ![alt](url) - protect URL
        result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url, offset) => {
            const urlPlaceholder = this.createPlaceholder(index++, 'IMG');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: url,
                placeholder: urlPlaceholder
            });
            return `![${alt}](${urlPlaceholder})`;
        });

        // 6. Reference-style links: [text][ref] and [ref]: url
        result = result.replace(/^\[([^\]]+)\]:\s*(.+)$/gm, (match, ref, url, offset) => {
            const urlPlaceholder = this.createPlaceholder(index++, 'REF');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: url,
                placeholder: urlPlaceholder
            });
            return `[${ref}]: ${urlPlaceholder}`;
        });

        // 7. HTML tags (preserve as-is)
        result = result.replace(/<[^>]+>/g, (match, offset) => {
            const placeholder = this.createPlaceholder(index++, 'HTML');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        return { text: result, regions };
    }
}

/**
 * JSON processor - protects keys, only translates string values
 */
export class JsonProcessor extends ContentProcessor {
    readonly languageId = 'json';

    process(text: string): ProcessedText {
        const regions: ProtectedRegion[] = [];
        let index = 0;

        // Protect everything except string values
        // This is complex for JSON, so we use a different approach:
        // Protect all structural elements and keys

        let result = text;

        // Protect keys: "key":
        result = result.replace(/"([^"\\]|\\.)*"\s*:/g, (match, _, offset) => {
            const placeholder = this.createPlaceholder(index++, 'KEY');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        // Protect numbers, booleans, null
        result = result.replace(/:\s*(-?\d+\.?\d*|true|false|null)(?=[,}\]\s])/g, (match, value, offset) => {
            const placeholder = this.createPlaceholder(index++, 'VAL');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        return { text: result, regions };
    }
}

/**
 * HTML processor - protects tags and attributes, translates text content
 */
export class HtmlProcessor extends ContentProcessor {
    readonly languageId = 'html';

    process(text: string): ProcessedText {
        const regions: ProtectedRegion[] = [];
        let result = text;
        let index = 0;

        // Protect script tags entirely
        result = result.replace(/<script[\s\S]*?<\/script>/gi, (match, offset) => {
            const placeholder = this.createPlaceholder(index++, 'SCRIPT');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        // Protect style tags entirely
        result = result.replace(/<style[\s\S]*?<\/style>/gi, (match, offset) => {
            const placeholder = this.createPlaceholder(index++, 'STYLE');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        // Protect code/pre tags entirely
        result = result.replace(/<(code|pre)[\s\S]*?<\/\1>/gi, (match, _, offset) => {
            const placeholder = this.createPlaceholder(index++, 'CODE');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        // Protect HTML tags (but not content between them)
        result = result.replace(/<[^>]+>/g, (match, offset) => {
            const placeholder = this.createPlaceholder(index++, 'TAG');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        return { text: result, regions };
    }
}

// Registry of content processors
const processors: Map<string, ContentProcessor> = new Map();

export function registerProcessor(processor: ContentProcessor): void {
    processors.set(processor.languageId, processor);
}

export function getProcessor(languageId: string): ContentProcessor | null {
    return processors.get(languageId) || null;
}

// Register default processors
registerProcessor(new MarkdownProcessor());
registerProcessor(new JsonProcessor());
registerProcessor(new HtmlProcessor());

// Also register for aliases
processors.set('md', processors.get('markdown')!);
processors.set('jsonc', processors.get('json')!);
processors.set('htm', processors.get('html')!);

/**
 * Enhanced Markdown processor - extracts comments from code blocks for translation
 */
export class EnhancedMarkdownProcessor extends ContentProcessor {
    readonly languageId = 'markdown';
    private codeBlockExtractor = new CodeBlockCommentExtractor();

    /**
     * Process markdown with intelligent code block handling
     * Extracts comments from code blocks for separate translation
     */
    processWithCodeBlocks(text: string): EnhancedProcessedText {
        const regions: ProtectedRegion[] = [];
        const codeBlockComments: string[] = [];
        const commentMapping = new Map<string, { blockIndex: number; commentIndex: number }>();
        let result = text;
        let index = 0;
        let blockIndex = 0;

        this.codeBlockExtractor.resetIndex();

        // 1. Process fenced code blocks with comment extraction
        // Use \r?\n to handle both Unix (\n) and Windows (\r\n) line endings
        // Make trailing newline optional for edge cases like ```js\ncode```
        result = result.replace(/```([\w-]*)\r?\n([\s\S]*?)(?:\r?\n)?```/g, (match, lang, code, offset) => {
            const language = lang || '';
            const codeBlockResult = this.codeBlockExtractor.processCodeBlock(code, language);

            // Collect comments for translation
            for (let i = 0; i < codeBlockResult.comments.length; i++) {
                const comment = codeBlockResult.comments[i];
                codeBlockComments.push(comment.text);
                commentMapping.set(comment.placeholder, {
                    blockIndex,
                    commentIndex: i
                });
            }

            const placeholder = this.createPlaceholder(index++, 'CODE');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder,
                language,
                codeBlockData: codeBlockResult
            });

            blockIndex++;
            return placeholder;
        });

        // 2. Indented code blocks (4 spaces or 1 tab at line start) - preserve as-is
        result = result.replace(/(?:^|\r?\n)((?:[ ]{4}|\t).+(?:\r?\n(?:[ ]{4}|\t).+)*)/g, (match, code, offset) => {
            const placeholder = this.createPlaceholder(index++, 'INDENT');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        // 2.5. Tables - protect entire table structure
        // Translation APIs often break table formatting (pipes, newlines)
        // so we protect the entire table and don't translate its contents
        result = result.replace(/^(\|.+\|)\r?\n(\|[-:\s|]+\|)\r?\n((?:\|.+\|(?:\r?\n)?)+)/gm, (match, _headerRow, _separatorRow, _bodyRows, offset) => {
            const placeholder = this.createPlaceholder(index++, 'TABLE');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        // 3. Inline code: `code` - protect entirely (no translation)
        result = result.replace(/`[^`\n]+`/g, (match, offset) => {
            const placeholder = this.createPlaceholder(index++, 'INLINE');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        // 4. Links: [text](url) - protect URL part only
        result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, url, offset) => {
            const urlPlaceholder = this.createPlaceholder(index++, 'URL');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: url,
                placeholder: urlPlaceholder
            });
            return `[${linkText}](${urlPlaceholder})`;
        });

        // 5. Images: ![alt](url) - protect URL
        result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url, offset) => {
            const urlPlaceholder = this.createPlaceholder(index++, 'IMG');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: url,
                placeholder: urlPlaceholder
            });
            return `![${alt}](${urlPlaceholder})`;
        });

        // 6. Reference-style links: [text][ref] and [ref]: url
        result = result.replace(/^\[([^\]]+)\]:\s*(.+)$/gm, (match, ref, url, offset) => {
            const urlPlaceholder = this.createPlaceholder(index++, 'REF');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: url,
                placeholder: urlPlaceholder
            });
            return `[${ref}]: ${urlPlaceholder}`;
        });

        // 7. HTML tags (preserve as-is)
        result = result.replace(/<[^>]+>/g, (match, offset) => {
            const placeholder = this.createPlaceholder(index++, 'HTML');
            regions.push({
                start: offset,
                end: offset + match.length,
                content: match,
                placeholder
            });
            return placeholder;
        });

        return {
            text: result,
            regions,
            codeBlockComments,
            commentMapping
        };
    }

    /**
     * Restore markdown with translated comments in code blocks
     */
    restoreWithTranslatedComments(
        translatedText: string,
        regions: ProtectedRegion[],
        translatedComments: string[]
    ): string {
        let result = translatedText;

        // Sort regions by placeholder (reverse order for safe replacement)
        const sortedRegions = [...regions].sort((a, b) =>
            b.placeholder.localeCompare(a.placeholder)
        );

        for (const region of sortedRegions) {
            if (region.codeBlockData && region.codeBlockData.comments.length > 0) {
                // Code block with comments - rebuild with translated comments
                const codeBlockData = region.codeBlockData;
                const blockCommentTranslations: string[] = [];

                // Get translations for this block's comments
                for (const comment of codeBlockData.comments) {
                    const index = translatedComments.findIndex((_, i) => {
                        // Find by matching placeholder in the original comment list
                        const allComments = regions
                            .filter(r => r.codeBlockData)
                            .flatMap(r => r.codeBlockData!.comments);
                        return allComments[i]?.placeholder === comment.placeholder;
                    });

                    if (index !== -1) {
                        blockCommentTranslations.push(translatedComments[index]);
                    } else {
                        blockCommentTranslations.push(comment.text);
                    }
                }

                const rebuiltCode = this.codeBlockExtractor.rebuildCodeBlock(
                    codeBlockData,
                    blockCommentTranslations
                );

                const rebuiltBlock = '```' + (region.language || '') + '\n' + rebuiltCode + '\n```';
                result = result.replace(region.placeholder, rebuiltBlock);
            } else {
                // Non-code-block region - restore original content
                result = result.replace(region.placeholder, region.content);
            }
        }

        return result;
    }

    /**
     * Standard process method (delegates to processWithCodeBlocks)
     */
    process(text: string): ProcessedText {
        const enhanced = this.processWithCodeBlocks(text);
        return {
            text: enhanced.text,
            regions: enhanced.regions
        };
    }
}
