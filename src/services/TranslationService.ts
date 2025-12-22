import * as vscode from 'vscode';
import {
    TranslationProvider,
    GoogleTranslateProvider,
    GeminiTranslateProvider
} from '../providers';
import { CommentExtractor, getProcessor, EnhancedMarkdownProcessor } from '../parsers';

export interface MarkdownTranslationResult {
    markdown: string;  // Translated markdown source
    html: string;      // Rendered HTML (not used currently, for future extension)
}

export class TranslationService {
    private googleProvider: GoogleTranslateProvider;
    private geminiProvider: GeminiTranslateProvider;
    private commentExtractor: CommentExtractor;
    private enhancedMarkdownProcessor: EnhancedMarkdownProcessor;

    constructor() {
        this.googleProvider = new GoogleTranslateProvider();
        this.commentExtractor = new CommentExtractor();
        this.enhancedMarkdownProcessor = new EnhancedMarkdownProcessor();

        const config = vscode.workspace.getConfiguration('translatePanel');
        const apiKey = config.get<string>('geminiApiKey', '');
        this.geminiProvider = new GeminiTranslateProvider(apiKey);

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('translatePanel.geminiApiKey')) {
                const newApiKey = vscode.workspace
                    .getConfiguration('translatePanel')
                    .get<string>('geminiApiKey', '');
                this.geminiProvider.updateApiKey(newApiKey);
            }
        });
    }

    /**
     * Translate content with language-aware processing
     */
    async translateDocument(text: string, languageId: string, targetLang: string): Promise<string> {
        // Check for content processor first (Markdown, JSON, HTML, etc.)
        const contentProcessor = getProcessor(languageId);
        if (contentProcessor) {
            return this.translateWithProcessor(text, contentProcessor, targetLang);
        }

        // Check for code file (extract comments only)
        const processed = this.commentExtractor.extract(text, languageId);

        if (!processed.isCodeFile) {
            // Plain text - translate everything
            return this.translate(text, targetLang);
        }

        if (processed.comments.length === 0) {
            // No comments found - return original
            return text;
        }

        // Get texts to translate
        const textsToTranslate = this.commentExtractor.getTextsForTranslation(processed);

        // Translate all comments
        const translatedTexts = await this.translateBatch(textsToTranslate, targetLang);

        // Rebuild with translated comments
        return this.commentExtractor.rebuild(processed, translatedTexts);
    }

    /**
     * Translate markdown with intelligent code block handling
     * Extracts comments from code blocks and translates them separately
     */
    async translateMarkdownDocument(text: string, targetLang: string): Promise<MarkdownTranslationResult> {
        // Process markdown to extract code block comments
        const processed = this.enhancedMarkdownProcessor.processWithCodeBlocks(text);

        // Translate markdown prose (with placeholders for code blocks)
        const translatedProse = await this.translate(processed.text, targetLang);

        // Translate code block comments
        let translatedComments: string[] = [];
        if (processed.codeBlockComments.length > 0) {
            translatedComments = await this.translateBatch(processed.codeBlockComments, targetLang);
        }

        // Restore markdown with translated comments in code blocks
        const translatedMarkdown = this.enhancedMarkdownProcessor.restoreWithTranslatedComments(
            translatedProse,
            processed.regions,
            translatedComments
        );

        return {
            markdown: translatedMarkdown,
            html: ''  // HTML rendering is done in TranslatePanel
        };
    }

    /**
     * Translate using content processor (protects regions, translates rest)
     */
    private async translateWithProcessor(
        text: string,
        processor: import('../parsers').ContentProcessor,
        targetLang: string
    ): Promise<string> {
        // Process text to extract protected regions
        const processed = processor.process(text);

        // Translate the text with placeholders
        const translated = await this.translate(processed.text, targetLang);

        // Restore protected regions
        return processor.restore(translated, processed.regions);
    }

    /**
     * Translate a single text
     */
    async translate(text: string, targetLang: string): Promise<string> {
        const provider = this.getActiveProvider();
        return provider.translate(text, targetLang);
    }

    /**
     * Translate multiple texts efficiently
     */
    async translateBatch(texts: string[], targetLang: string): Promise<string[]> {
        if (texts.length === 0) return [];

        const provider = this.getActiveProvider();

        // For efficiency, join small texts with a delimiter and translate together
        const DELIMITER = '\n§§§\n';
        const MAX_BATCH_SIZE = 3000;

        const batches: string[][] = [];
        let currentBatch: string[] = [];
        let currentSize = 0;

        for (const text of texts) {
            if (currentSize + text.length > MAX_BATCH_SIZE && currentBatch.length > 0) {
                batches.push(currentBatch);
                currentBatch = [];
                currentSize = 0;
            }
            currentBatch.push(text);
            currentSize += text.length + DELIMITER.length;
        }

        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }

        const results: string[] = [];

        for (const batch of batches) {
            if (batch.length === 1) {
                const translated = await provider.translate(batch[0], targetLang);
                results.push(translated);
            } else {
                const combined = batch.join(DELIMITER);
                const translated = await provider.translate(combined, targetLang);
                const split = translated.split(/§§§|\n§§§\n/);

                // Handle cases where delimiter might be translated or modified
                if (split.length === batch.length) {
                    results.push(...split.map(s => s.trim()));
                } else {
                    // Fallback: translate individually
                    for (const text of batch) {
                        const t = await provider.translate(text, targetLang);
                        results.push(t);
                    }
                }
            }
        }

        return results;
    }

    private getActiveProvider(): TranslationProvider {
        const config = vscode.workspace.getConfiguration('translatePanel');
        const engine = config.get<string>('translationEngine', 'google');

        switch (engine) {
            case 'gemini':
                return this.geminiProvider;
            case 'google':
            default:
                return this.googleProvider;
        }
    }

    getProviderName(): string {
        return this.getActiveProvider().name;
    }
}
