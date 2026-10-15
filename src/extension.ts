import * as vscode from 'vscode';
import {
    PROJECTION_SCHEME,
    ProjectionDocumentProvider,
    ProjectionPairMode,
    VscodeProjectionPair,
} from './adapters/vscode';
import { LiteralBoundaryProjectionProvider } from './core/literalBoundary';
import {
    resolveSemanticPolicy,
    SemanticPolicySchema,
    HarnessFacility,
    HarnessProfile,
} from './core';
import { ScaffoldProjectionProvider } from './providers/ScaffoldProjectionProvider';

type RefreshMode = 'manual' | 'debounced';

const CSHARP_PYTHON_POLICY: SemanticPolicySchema = {
    id: 'csharp-python-v1',
    choices: [
        { id: 'linq', values: ['lazy', 'eager'], defaultValue: 'lazy' },
        { id: 'exceptions', values: ['throw', 'result'], defaultValue: 'throw' },
        { id: 'async', values: ['asyncio', 'sync'], defaultValue: 'asyncio' },
        { id: 'inheritance', values: ['inherit', 'compose'], defaultValue: 'inherit' },
        { id: 'attributes', values: ['decorators', 'registration'], defaultValue: 'decorators' },
    ],
};

const AVAILABLE_HARNESS: readonly HarnessFacility[] = [
    { id: 'decimal', targetLanguage: 'python', text: 'from decimal import Decimal\n' },
];

function configuredProfiles(targetLanguage: string): {
    policy: ReturnType<typeof resolveSemanticPolicy>;
    harness: HarnessProfile;
    facilities: readonly HarnessFacility[];
} {
    const config = vscode.workspace.getConfiguration('transpilePanel');
    const policy = resolveSemanticPolicy(
        CSHARP_PYTHON_POLICY,
        config.get<Record<string, string>>('policyChoices', {}),
    );
    const harness: HarnessProfile = {
        id: 'python-stdlib',
        targetLanguage,
        facilities: config.get<string[]>('harnessFacilities', []),
    };
    return { policy, harness, facilities: AVAILABLE_HARNESS };
}

export function activate(context: vscode.ExtensionContext): void {
    const documents = new ProjectionDocumentProvider();
    const provider = new LiteralBoundaryProjectionProvider(new ScaffoldProjectionProvider());
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

            const profiles = configuredProfiles(targetLanguage);
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
                    policy: profiles.policy,
                    harness: profiles.harness,
                    availableFacilities: profiles.facilities,
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
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration('transpilePanel.policyChoices') &&
                !event.affectsConfiguration('transpilePanel.harnessFacilities')) return;
            const pair = activePair;
            const source = sourceDocumentForPair();
            if (!pair || !source) return;
            try {
                const profiles = configuredProfiles(pair.targetLanguage);
                if (pair.updateProfiles(profiles.policy, profiles.harness, profiles.facilities)) {
                    clearDebounce();
                    void refreshPair(source).catch(reportError);
                }
            } catch (error) {
                reportError(error);
            }
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
