export interface TranslationProvider {
    readonly name: string;
    translate(text: string, targetLang: string): Promise<string>;
}
