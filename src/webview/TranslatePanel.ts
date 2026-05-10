import * as vscode from 'vscode';
import { TranslationService, MarkdownTranslationResult } from '../services/TranslationService';
import { MarkdownRenderer } from './MarkdownRenderer';

export class TranslatePanel {
    public static currentPanel: TranslatePanel | undefined;
    public static readonly viewType = 'translatePanel';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _localResourceRoots: readonly vscode.Uri[];
    private readonly _translationService: TranslationService;
    private readonly _markdownRenderer: MarkdownRenderer;
    private _disposables: vscode.Disposable[] = [];
    private _debounceTimer: NodeJS.Timeout | undefined;
    private _currentRequestId: number = 0;  // Track current request to cancel stale ones
    private _isTranslating: boolean = false;
    private _pendingDocument: vscode.TextDocument | null = null;
    private _translatedMarkdownSource: string = '';  // For copy feature
    private _lastDocumentUri: string = '';  // Track last translated document
    private _lastDocumentVersion: number = -1;  // Track document version to detect changes

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, localResourceRoots: readonly vscode.Uri[]) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._localResourceRoots = localResourceRoots;
        this._translationService = new TranslationService();
        this._markdownRenderer = new MarkdownRenderer();

        this._panel.webview.html = this._getInitialHtml();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.type) {
                    case 'copyMarkdown':
                        this._copyMarkdownToClipboard();
                        return;
                }
            },
            null,
            this._disposables
        );

        // Initial content load
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            this.updateContent(activeEditor.document);
        }
    }

    private async _copyMarkdownToClipboard(): Promise<void> {
        if (this._translatedMarkdownSource) {
            await vscode.env.clipboard.writeText(this._translatedMarkdownSource);
            this._panel.webview.postMessage({ type: 'copied' });
        }
    }

    private static _fsPathContains(rootFsPath: string, childFsPath: string): boolean {
        const root = rootFsPath.toLowerCase().replace(/[\\/]$/, '');
        const child = childFsPath.toLowerCase();
        return child === root || child.startsWith(root + '/') || child.startsWith(root + '\\');
    }

    private static _buildLocalResourceRoots(extensionUri: vscode.Uri, documentUri?: vscode.Uri): vscode.Uri[] {
        const roots: vscode.Uri[] = [extensionUri];
        if (vscode.workspace.workspaceFolders) {
            roots.push(...vscode.workspace.workspaceFolders.map(f => f.uri));
        }
        if (documentUri) {
            const docDir = vscode.Uri.joinPath(documentUri, '..');
            const alreadyCovered = roots.some(r =>
                TranslatePanel._fsPathContains(r.fsPath, documentUri.fsPath)
            );
            if (!alreadyCovered) {
                roots.push(docDir);
            }
        }
        return roots;
    }

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : vscode.ViewColumn.One;

        if (TranslatePanel.currentPanel) {
            TranslatePanel.currentPanel._panel.reveal(column);
            return;
        }

        const activeEditor = vscode.window.activeTextEditor;
        const localResourceRoots = TranslatePanel._buildLocalResourceRoots(
            extensionUri,
            activeEditor?.document.uri
        );

        const panel = vscode.window.createWebviewPanel(
            TranslatePanel.viewType,
            'Translate Preview',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots
            }
        );

        TranslatePanel.currentPanel = new TranslatePanel(panel, extensionUri, localResourceRoots);
    }

    public async updateContent(document: vscode.TextDocument, force: boolean = false) {
        // Recreate panel if document directory is not within any localResourceRoot
        const isCovered = this._localResourceRoots.some(root =>
            TranslatePanel._fsPathContains(root.fsPath, document.uri.fsPath)
        );
        if (!isCovered) {
            const currentColumn = this._panel.viewColumn ?? vscode.ViewColumn.Beside;
            const extensionUri = this._extensionUri;
            this._currentRequestId++;  // invalidate any in-flight translation on old panel
            this.dispose();
            const newRoots = TranslatePanel._buildLocalResourceRoots(extensionUri, document.uri);
            const panel = vscode.window.createWebviewPanel(
                TranslatePanel.viewType,
                'Translate Preview',
                currentColumn,
                { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: newRoots }
            );
            const newInstance = new TranslatePanel(panel, extensionUri, newRoots);
            TranslatePanel.currentPanel = newInstance;
            // Ensure the triggering document is translated (constructor may use activeEditor.document)
            newInstance.updateContent(document);
            return;
        }

        const docUri = document.uri.toString();
        const docVersion = document.version;

        // Skip if same document and version (no actual changes)
        if (!force && docUri === this._lastDocumentUri && docVersion === this._lastDocumentVersion) {
            return;
        }

        // If already translating, queue this request
        if (this._isTranslating) {
            this._pendingDocument = document;
            return;
        }

        // Update tracking
        this._lastDocumentUri = docUri;
        this._lastDocumentVersion = docVersion;

        const requestId = ++this._currentRequestId;
        const text = document.getText();
        const fileName = document.fileName.split(/[/\\]/).pop() || 'Unknown';
        const languageId = document.languageId;
        const isMarkdown = languageId === 'markdown' || languageId === 'md';

        this._isTranslating = true;
        this._panel.webview.html = this._getLoadingHtml(fileName);

        try {
            const config = vscode.workspace.getConfiguration('translatePanel');
            const configuredLang = config.get<string>('targetLanguage', '');
            const targetLang = configuredLang || vscode.env.language.split('-')[0] || 'en';
            const engine = config.get<string>('translationEngine', 'google');

            // Only update if this is still the latest request
            if (requestId === this._currentRequestId) {
                if (isMarkdown) {
                    // Use enhanced markdown translation
                    const result = await this._translationService.translateMarkdownDocument(text, targetLang);
                    this._translatedMarkdownSource = result.markdown;

                    // Render markdown to HTML
                    const renderedHtml = this._markdownRenderer.render(result.markdown);

                    this._panel.webview.html = this._getMarkdownContentHtml(
                        fileName,
                        languageId,
                        renderedHtml,
                        targetLang,
                        engine,
                        document.uri
                    );
                } else {
                    // Use standard translation for non-markdown files
                    const translated = await this._translationService.translateDocument(text, languageId, targetLang);
                    this._translatedMarkdownSource = '';

                    this._panel.webview.html = this._getContentHtml(
                        fileName,
                        languageId,
                        text,
                        translated,
                        targetLang,
                        engine
                    );
                }
            }
        } catch (error) {
            // Only show error if this is still the latest request
            if (requestId === this._currentRequestId) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                this._panel.webview.html = this._getErrorHtml(fileName, errorMessage);
            }
        } finally {
            this._isTranslating = false;

            // Process pending request if any
            if (this._pendingDocument) {
                const pending = this._pendingDocument;
                this._pendingDocument = null;
                this.updateContent(pending);
            }
        }
    }

    public updateContentDebounced(document: vscode.TextDocument) {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }

        const config = vscode.workspace.getConfiguration('translatePanel');
        const delay = config.get<number>('debounceDelay', 500);

        this._debounceTimer = setTimeout(() => {
            this.updateContent(document);
        }, delay);
    }

    /**
     * Sync scroll position with the editor using percentage-based scrolling
     * @param percentage Scroll percentage (0 to 1), adjusted for editor vs preview scroll behavior
     */
    public syncScroll(percentage: number) {
        this._panel.webview.postMessage({
            type: 'scroll',
            percentage: percentage
        });
    }

    private _getInitialHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Translate Preview</title>
    <style>${this._getStyles()}</style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>Translate Panel</h2>
        </div>
        <div class="content">
            <p class="info">Open a file to see its translation.</p>
        </div>
    </div>
</body>
</html>`;
    }

    private _getLoadingHtml(fileName: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Translate Preview</title>
    <style>${this._getStyles()}</style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>${this._escapeHtml(fileName)}</h2>
        </div>
        <div class="content loading">
            <div class="spinner"></div>
            <p>Translating...</p>
        </div>
    </div>
</body>
</html>`;
    }

    private _getContentHtml(
        fileName: string,
        languageId: string,
        original: string,
        translated: string,
        targetLang: string,
        engine: string
    ): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Translate Preview</title>
    <style>${this._getStyles()}</style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>${this._escapeHtml(fileName)}</h2>
            <div class="meta">
                <span class="badge">${languageId}</span>
                <span class="badge">${targetLang.toUpperCase()}</span>
                <span class="badge engine">${engine}</span>
            </div>
        </div>
        <div class="content" id="content">
            <pre class="translated">${this._escapeHtml(translated)}</pre>
        </div>
    </div>
    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            const content = document.getElementById('content');

            window.addEventListener('message', event => {
                const message = event.data;
                if (message.type === 'scroll') {
                    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
                    const targetScroll = Math.round(maxScroll * message.percentage);
                    window.scrollTo({ top: targetScroll, behavior: 'auto' });
                }
            });
        })();
    </script>
</body>
</html>`;
    }

    private _resolveImagePaths(html: string, documentUri: vscode.Uri): string {
        const documentDir = vscode.Uri.joinPath(documentUri, '..');
        return html.replace(/(<img\b[^>]*?\ssrc=")([^"]+)(")/gi, (match, prefix, src, suffix) => {
            if (/^(data:|https?:|vscode-resource:|vscode-webview-resource:)/i.test(src)) {
                return match;
            }
            try {
                const resolvedUri = src.startsWith('/')
                    ? vscode.Uri.file(src)
                    : vscode.Uri.joinPath(documentDir, src);
                const webviewUri = this._panel.webview.asWebviewUri(resolvedUri);
                return `${prefix}${webviewUri}${suffix}`;
            } catch {
                return match;
            }
        });
    }

    private _getMarkdownContentHtml(
        fileName: string,
        languageId: string,
        renderedHtml: string,
        targetLang: string,
        engine: string,
        documentUri?: vscode.Uri
    ): string {
        const resolvedHtml = documentUri ? this._resolveImagePaths(renderedHtml, documentUri) : renderedHtml;
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Translate Preview</title>
    <style>
        ${this._getStyles()}
        ${MarkdownRenderer.getHighlightStyles()}
        ${MarkdownRenderer.getMarkdownStyles()}

        /* Copy button styles */
        .copy-button {
            padding: 4px 10px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .copy-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .copy-button.copied {
            background: var(--vscode-testing-iconPassed, #4caf50);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>${this._escapeHtml(fileName)}</h2>
            <div class="meta">
                <button id="copyBtn" class="copy-button" title="Copy Markdown">
                    <span>Copy MD</span>
                </button>
                <span class="badge">${languageId}</span>
                <span class="badge">${targetLang.toUpperCase()}</span>
                <span class="badge engine">${engine}</span>
            </div>
        </div>
        <div class="content markdown-content" id="content">
            ${resolvedHtml}
        </div>
    </div>
    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            const copyBtn = document.getElementById('copyBtn');

            if (copyBtn) {
                copyBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'copyMarkdown' });
                });
            }

            window.addEventListener('message', event => {
                const message = event.data;
                if (message.type === 'scroll') {
                    // Percentage-based scroll sync
                    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
                    const targetScroll = Math.round(maxScroll * message.percentage);
                    window.scrollTo({ top: targetScroll, behavior: 'smooth' });
                } else if (message.type === 'copied') {
                    if (copyBtn) {
                        const originalText = copyBtn.innerHTML;
                        copyBtn.innerHTML = '<span>Copied!</span>';
                        copyBtn.classList.add('copied');
                        setTimeout(() => {
                            copyBtn.innerHTML = originalText;
                            copyBtn.classList.remove('copied');
                        }, 2000);
                    }
                }
            });
        })();
    </script>
</body>
</html>`;
    }

    private _getErrorHtml(fileName: string, error: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Translate Preview</title>
    <style>${this._getStyles()}</style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>${this._escapeHtml(fileName)}</h2>
        </div>
        <div class="content error">
            <p class="error-title">Translation Error</p>
            <p class="error-message">${this._escapeHtml(error)}</p>
        </div>
    </div>
</body>
</html>`;
    }

    private _getStyles(): string {
        return `
            :root {
                --bg-color: var(--vscode-editor-background);
                --text-color: var(--vscode-editor-foreground);
                --border-color: var(--vscode-panel-border);
                --badge-bg: var(--vscode-badge-background);
                --badge-fg: var(--vscode-badge-foreground);
            }
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
                font-family: var(--vscode-font-family);
                font-size: var(--vscode-font-size);
                color: var(--text-color);
                background: var(--bg-color);
                padding: 16px;
            }
            .container { max-width: 100%; }
            .header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding-bottom: 12px;
                border-bottom: 1px solid var(--border-color);
                margin-bottom: 16px;
            }
            .header h2 {
                font-size: 14px;
                font-weight: 600;
            }
            .meta { display: flex; gap: 8px; }
            .badge {
                font-size: 11px;
                padding: 2px 6px;
                border-radius: 3px;
                background: var(--badge-bg);
                color: var(--badge-fg);
                text-transform: uppercase;
            }
            .badge.engine {
                background: var(--vscode-statusBarItem-prominentBackground);
            }
            .content { line-height: 1.6; }
            .content.loading {
                display: flex;
                flex-direction: column;
                align-items: center;
                padding: 40px;
                gap: 16px;
            }
            .spinner {
                width: 24px;
                height: 24px;
                border: 2px solid var(--border-color);
                border-top-color: var(--vscode-progressBar-background);
                border-radius: 50%;
                animation: spin 1s linear infinite;
            }
            @keyframes spin { to { transform: rotate(360deg); } }
            .translated {
                white-space: pre-wrap;
                word-wrap: break-word;
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                line-height: 1.5;
            }
            .error { color: var(--vscode-errorForeground); padding: 20px; }
            .error-title { font-weight: bold; margin-bottom: 8px; }
            .info { color: var(--vscode-descriptionForeground); padding: 20px; text-align: center; }
        `;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    public dispose() {
        TranslatePanel.currentPanel = undefined;

        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
