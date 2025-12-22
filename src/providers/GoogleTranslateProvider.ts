import { TranslationProvider } from './TranslationProvider';

export class GoogleTranslateProvider implements TranslationProvider {
    readonly name = 'google';

    private readonly baseUrl = 'https://translate.googleapis.com/translate_a/single';

    async translate(text: string, targetLang: string): Promise<string> {
        if (!text.trim()) {
            return '';
        }

        // Split text into chunks to handle large documents
        const chunks = this.splitText(text, 4500);
        const translatedChunks: string[] = [];

        for (const chunk of chunks) {
            const translated = await this.translateChunk(chunk, targetLang);
            translatedChunks.push(translated);
        }

        return translatedChunks.join('');
    }

    private async translateChunk(text: string, targetLang: string): Promise<string> {
        const params = new URLSearchParams({
            client: 'gtx',
            sl: 'auto',
            tl: targetLang,
            dt: 't',
            q: text
        });

        const url = `${this.baseUrl}?${params.toString()}`;

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`Google Translate API error: ${response.status}`);
        }

        const data = await response.json();

        // Parse response: [[["translated text","original text",null,null,10],...],...]
        if (!Array.isArray(data) || !Array.isArray(data[0])) {
            throw new Error('Unexpected response format from Google Translate');
        }

        const translatedParts: string[] = [];
        for (const part of data[0]) {
            if (Array.isArray(part) && part[0]) {
                translatedParts.push(part[0]);
            }
        }

        return translatedParts.join('');
    }

    private splitText(text: string, maxLength: number): string[] {
        if (text.length <= maxLength) {
            return [text];
        }

        const chunks: string[] = [];
        const lines = text.split('\n');
        let currentChunk = '';

        for (const line of lines) {
            if (currentChunk.length + line.length + 1 > maxLength) {
                if (currentChunk) {
                    chunks.push(currentChunk);
                }
                // If single line is too long, split it
                if (line.length > maxLength) {
                    const lineChunks = this.splitLongLine(line, maxLength);
                    chunks.push(...lineChunks.slice(0, -1));
                    currentChunk = lineChunks[lineChunks.length - 1] || '';
                } else {
                    currentChunk = line;
                }
            } else {
                currentChunk += (currentChunk ? '\n' : '') + line;
            }
        }

        if (currentChunk) {
            chunks.push(currentChunk);
        }

        return chunks;
    }

    private splitLongLine(line: string, maxLength: number): string[] {
        const chunks: string[] = [];
        for (let i = 0; i < line.length; i += maxLength) {
            chunks.push(line.slice(i, i + maxLength));
        }
        return chunks;
    }
}
