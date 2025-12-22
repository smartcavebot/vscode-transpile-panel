export interface TranslationProvider {
    readonly name: string;
    translate(text: string, targetLang: string): Promise<string>;
}

export interface TranslationResult {
    original: string;
    translated: string;
    targetLanguage: string;
    engine: string;
    timestamp: number;
}

export interface ExtensionConfig {
    targetLanguage: string;
    translationEngine: 'google' | 'gemini';
    updateMode: 'onType' | 'onSave';
    geminiApiKey: string;
    debounceDelay: number;
}
