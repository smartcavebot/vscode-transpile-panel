import { TranslationProvider } from './TranslationProvider';
import { GoogleGenerativeAI } from '@google/generative-ai';

export class GeminiTranslateProvider implements TranslationProvider {
    readonly name = 'gemini';

    private genAI: GoogleGenerativeAI | null = null;
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
        if (apiKey) {
            this.genAI = new GoogleGenerativeAI(apiKey);
        }
    }

    async translate(text: string, targetLang: string): Promise<string> {
        if (!text.trim()) {
            return '';
        }

        if (!this.genAI) {
            throw new Error('Gemini API key is not configured. Please set translatePanel.geminiApiKey in settings.');
        }

        const model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        const languageNames: Record<string, string> = {
            ko: 'Korean',
            en: 'English',
            ja: 'Japanese',
            zh: 'Chinese',
            es: 'Spanish',
            fr: 'French',
            de: 'German',
            pt: 'Portuguese',
            ru: 'Russian',
            ar: 'Arabic',
            hi: 'Hindi',
            vi: 'Vietnamese',
            th: 'Thai',
            it: 'Italian',
            nl: 'Dutch'
        };

        const targetLanguageName = languageNames[targetLang] || targetLang;

        const prompt = `Translate the following text to ${targetLanguageName}.
Preserve all code structures, variable names, function names, and programming syntax.
Only translate natural language text like comments, strings, and documentation.
Return only the translated content without any explanation.

Text to translate:
${text}`;

        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Gemini translation failed: ${error.message}`);
            }
            throw new Error('Gemini translation failed: Unknown error');
        }
    }

    updateApiKey(apiKey: string) {
        this.apiKey = apiKey;
        if (apiKey) {
            this.genAI = new GoogleGenerativeAI(apiKey);
        } else {
            this.genAI = null;
        }
    }
}
