import * as vscode from 'vscode';
import {
    PROJECTION_SCHEME,
    ProjectionDocumentProvider,
    ProjectionPairMode,
    VscodeProjectionPair,
} from './adapters/vscode';
import { ScaffoldProjectionProvider } from './providers/ScaffoldProjectionProvider';

type RefreshMode = 'manual' | 'debounced';

export function activate(context: vscode.ExtensionContext): void {
    const documents = new ProjectionDocumentProvider();
    const provider = new ScaffoldProjectionProvider();
    let activePair: VscodeProjectionPair | undefined;
    let debounceTimer: NodeJS.Timeout | undefined;
    let openingPair = false;

    context.subscriptions.push(
        documents,
        vscode.workspace.registerTextDocumentContentProvider(PROJECTION_SCHEME, documents),
    );

    const clearDebounce = (): void => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = undefined;
        }
    };

    const disposePair = (): void => {
        clearDebounce();
        activePair?.dispose();
        activePair = undefined;
    };

    const sourceDocumentForPair = (): vscode.TextDocument | undefined => {
        if (!activePair) {
            return undefined;
        }
        const key = activePair.sourceUri.toString();
        return vscode.workspace.textDocuments.find((document) => document.uri.toString() === key);
    };

    const refreshPair = async (document?: vscode.TextDocument): Promise<void> => {
        const pair = activePair;
        const source = document ?? sourceDocumentForPair();
        if (!pair || !source || !pair.matches(source)) {
            return;
        }
        await pair.refresh(source);
    };

    const scheduleRefresh = (document: vscode.TextDocument): void => {
        const config = vscode.workspace.getConfiguration('transpilePanel');
        const mode = config.get<RefreshMode>('refreshMode', 'debounced');
        if (mode !== 'debounced') {
            return;
        }

        clearDebounce();
        const delay = Math.max(100, config.get<number>('debounceMs', 750));
        debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            void refreshPair(document).catch(reportError);
        }, delay);
    };

    const openForEditor = async (editor: vscode.TextEditor): Promise<void> => {
        if (openingPair || editor.document.uri.scheme === PROJECTION_SCHEME) {
            return;
        }

        openingPair = true;
        try {
            const config = vscode.workspace.getConfiguration('transpilePanel');
            const targetLanguage = config.get<string>('targetLanguage', 'python').trim() || 'python';
            const mode = config.get<ProjectionPairMode>('pairingMode', 'pinned');
            const contextLines = Math.max(0, config.get<number>('contextLines', 12));
            const maxContextCharacters = Math.max(
                2,
                config.get<number>('maxContextCharacters', 12000),
            );
            const coverageChunkLines = Math.max(
                1,
                config.get<number>('coverageChunkLines', 80),
            );
            const coverageChunkCharacters = Math.max(
                2,
                config.get<number>('coverageChunkCharacters', 6000),
            );

            disposePair();
            const pair = new VscodeProjectionPair(
                editor.document.uri,
                targetLanguage,
                provider,
                documents,
                {
                    sourceLanguage: editor.document.languageId,
                    targetLanguage,
                    contextLines,
                    maxContextCharacters,
                    coverageChunkLines,
                    coverageChunkCharacters,
                    mode,
                },
            );
            activePair = pair;

            await pair.initialize(editor.document);
            const opened = await vscode.workspace.openTextDocument(pair.targetUri);
            const targetDocument = await vscode.languages.setTextDocumentLanguage(opened, targetLanguage);
            await vscode.window.showTextDocument(targetDocument, {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: true,
                preview: false,
            });
        } finally {
            openingPair = false;
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('transpilePanel.open', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme === PROJECTION_SCHEME) {
                return;
            }
            return openForEditor(editor).catch(reportError);
        }),
        vscode.commands.registerCommand('transpilePanel.refresh', () => {
            clearDebounce();
            return refreshPair().catch(reportError);
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            const pair = activePair;
            if (!pair || !pair.matches(event.document)) {
                return;
            }

            if (pair.applySourceChange(event)) {
                scheduleRefresh(event.document);
            }
        }),
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            const pair = activePair;
            if (
                !editor ||
                editor.document.uri.scheme === PROJECTION_SCHEME ||
                openingPair ||
                !pair ||
                pair.mode !== 'followActive' ||
                pair.matches(editor.document)
            ) {
                return;
            }
            void openForEditor(editor).catch(reportError);
        }),
        {
            dispose: disposePair,
        },
    );
}

export function deactivate(): void {
    // VS Code disposes activation subscriptions.
}

function reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Transpile Panel: ${message}`);
}
