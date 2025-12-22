/**
 * Markdown to HTML renderer with syntax highlighting
 */

import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';

export interface HeadingInfo {
    id: string;
    text: string;
    level: number;
    index: number;
}

export class MarkdownRenderer {
    private headingIndex = 0;
    private lastHeadings: HeadingInfo[] = [];

    constructor() {
        // Create custom renderer
        const renderer = new Renderer();

        // Override heading rendering to add IDs for scroll sync
        renderer.heading = (text: string, level: number): string => {
            const id = `heading-${this.headingIndex}`;
            this.lastHeadings.push({
                id,
                text: this.stripHtml(text),
                level,
                index: this.headingIndex
            });
            this.headingIndex++;
            return `<h${level} id="${id}">${text}</h${level}>`;
        };

        // Override code block rendering with syntax highlighting
        renderer.code = (code: string, infostring: string | undefined): string => {
            const language = infostring || '';
            const validLanguage = hljs.getLanguage(language) ? language : 'plaintext';

            try {
                const highlighted = hljs.highlight(code, {
                    language: validLanguage,
                    ignoreIllegals: true
                }).value;

                return `<pre><code class="hljs language-${validLanguage}">${highlighted}</code></pre>`;
            } catch {
                // Fallback to plain text if highlighting fails
                return `<pre><code class="hljs">${this.escapeHtml(code)}</code></pre>`;
            }
        };

        // Configure marked with custom renderer
        marked.setOptions({
            gfm: true,
            breaks: false,
            renderer: renderer
        });
    }

    /**
     * Render markdown to HTML
     */
    render(markdown: string): string {
        // Reset heading tracking
        this.headingIndex = 0;
        this.lastHeadings = [];
        return marked.parse(markdown) as string;
    }

    /**
     * Get headings from the last rendered markdown
     */
    getHeadings(): HeadingInfo[] {
        return [...this.lastHeadings];
    }

    /**
     * Extract heading line numbers from source markdown
     */
    static extractSourceHeadings(markdown: string): { line: number; text: string; level: number }[] {
        const headings: { line: number; text: string; level: number }[] = [];
        const lines = markdown.split(/\r?\n/);

        lines.forEach((line, index) => {
            // Match ATX-style headings: # Heading
            const match = line.match(/^(#{1,6})\s+(.+)$/);
            if (match) {
                headings.push({
                    line: index,
                    text: match[2].trim(),
                    level: match[1].length
                });
            }
        });

        return headings;
    }

    private stripHtml(html: string): string {
        return html.replace(/<[^>]*>/g, '');
    }

    /**
     * Get highlight.js CSS for VS Code theme compatibility
     */
    static getHighlightStyles(): string {
        return `
/* Highlight.js base styles - VS Code compatible */
.hljs {
    display: block;
    overflow-x: auto;
    padding: 1em;
    background: var(--vscode-textCodeBlock-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    border-radius: 4px;
    font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
    font-size: var(--vscode-editor-font-size, 14px);
    line-height: 1.5;
}

/* Syntax highlighting colors - based on VS Code Dark+ theme */
.hljs-keyword,
.hljs-selector-tag,
.hljs-literal,
.hljs-section,
.hljs-link {
    color: #569cd6;
}

.hljs-string,
.hljs-title,
.hljs-name,
.hljs-type,
.hljs-attribute,
.hljs-symbol,
.hljs-bullet,
.hljs-addition,
.hljs-variable,
.hljs-template-tag,
.hljs-template-variable {
    color: #ce9178;
}

.hljs-comment,
.hljs-quote,
.hljs-deletion,
.hljs-meta {
    color: #6a9955;
}

.hljs-keyword,
.hljs-selector-tag,
.hljs-literal,
.hljs-title,
.hljs-section,
.hljs-doctag,
.hljs-type,
.hljs-name,
.hljs-strong {
    font-weight: normal;
}

.hljs-emphasis {
    font-style: italic;
}

.hljs-number {
    color: #b5cea8;
}

.hljs-function .hljs-title,
.hljs-class .hljs-title {
    color: #dcdcaa;
}

.hljs-params {
    color: #9cdcfe;
}

.hljs-built_in {
    color: #4ec9b0;
}

.hljs-attr {
    color: #9cdcfe;
}

.hljs-regexp {
    color: #d16969;
}
`;
    }

    /**
     * Get markdown content styles
     */
    static getMarkdownStyles(): string {
        return `
/* Markdown content styles */
.markdown-content {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif);
    font-size: var(--vscode-font-size, 14px);
    line-height: 1.6;
    color: var(--vscode-editor-foreground, #d4d4d4);
    max-width: 100%;
    padding: 0 16px;
}

.markdown-content h1,
.markdown-content h2,
.markdown-content h3,
.markdown-content h4,
.markdown-content h5,
.markdown-content h6 {
    margin-top: 24px;
    margin-bottom: 16px;
    font-weight: 600;
    line-height: 1.25;
    color: var(--vscode-editor-foreground, #d4d4d4);
}

.markdown-content h1 {
    font-size: 2em;
    border-bottom: 1px solid var(--vscode-panel-border, #454545);
    padding-bottom: 8px;
}

.markdown-content h2 {
    font-size: 1.5em;
    border-bottom: 1px solid var(--vscode-panel-border, #454545);
    padding-bottom: 8px;
}

.markdown-content h3 {
    font-size: 1.25em;
}

.markdown-content p {
    margin-top: 0;
    margin-bottom: 16px;
}

.markdown-content code:not(.hljs) {
    background: var(--vscode-textCodeBlock-background, #1e1e1e);
    padding: 2px 6px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
    font-size: 0.9em;
}

.markdown-content pre {
    margin: 16px 0;
    overflow: auto;
}

.markdown-content pre > code {
    padding: 0;
    background: transparent;
}

.markdown-content blockquote {
    margin: 16px 0;
    padding: 0 16px;
    border-left: 4px solid var(--vscode-textBlockQuote-border, #007acc);
    color: var(--vscode-textBlockQuote-foreground, #999);
}

.markdown-content ul,
.markdown-content ol {
    margin-top: 0;
    margin-bottom: 16px;
    padding-left: 2em;
}

.markdown-content li {
    margin-bottom: 4px;
}

.markdown-content li > p {
    margin-bottom: 0;
}

.markdown-content table {
    border-collapse: collapse;
    width: 100%;
    margin: 16px 0;
}

.markdown-content th,
.markdown-content td {
    border: 1px solid var(--vscode-panel-border, #454545);
    padding: 8px 12px;
    text-align: left;
}

.markdown-content th {
    background: var(--vscode-editor-background, #252526);
    font-weight: 600;
}

.markdown-content tr:nth-child(even) {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
}

.markdown-content a {
    color: var(--vscode-textLink-foreground, #3794ff);
    text-decoration: none;
}

.markdown-content a:hover {
    text-decoration: underline;
}

.markdown-content img {
    max-width: 100%;
    height: auto;
}

.markdown-content hr {
    border: none;
    border-top: 1px solid var(--vscode-panel-border, #454545);
    margin: 24px 0;
}

/* Task list styles */
.markdown-content input[type="checkbox"] {
    margin-right: 8px;
}
`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
