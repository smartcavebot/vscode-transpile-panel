/**
 * Content processor for languages that need selective translation
 * (e.g., Markdown - translate text but preserve code blocks)
 */

export interface ProtectedRegion {
    start: number;
    end: number;
    content: string;
    placeholder: string;
}

export interface ProcessedText {
    text: string;                    // Text with placeholders
    regions: ProtectedRegion[];      // Protected regions to restore
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

    protected createPlaceholder(index: number, type: string): string {
        return `⟦${type}:${index}⟧`;
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
