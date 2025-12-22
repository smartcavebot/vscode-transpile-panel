import * as vscode from 'vscode';
import { TranslatePanel } from './webview/TranslatePanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('Translate Panel extension is now active');

    const openPreviewCommand = vscode.commands.registerCommand(
        'translatePanel.openPreview',
        () => {
            TranslatePanel.createOrShow(context.extensionUri);
        }
    );

    context.subscriptions.push(openPreviewCommand);

    // Listen for active editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && TranslatePanel.currentPanel) {
                TranslatePanel.currentPanel.updateContent(editor.document);
            }
        })
    );

    // Listen for scroll changes (visible range)
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
            if (TranslatePanel.currentPanel && event.visibleRanges.length > 0) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor === event.textEditor) {
                    const firstVisibleLine = event.visibleRanges[0].start.line;
                    const totalLines = activeEditor.document.lineCount;
                    const scrollPercentage = totalLines > 0 ? firstVisibleLine / totalLines : 0;
                    TranslatePanel.currentPanel.syncScroll(scrollPercentage);
                }
            }
        })
    );

    // Listen for document changes based on updateMode
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            const config = vscode.workspace.getConfiguration('translatePanel');
            const updateMode = config.get<string>('updateMode', 'onSave');

            if (updateMode === 'onType' && TranslatePanel.currentPanel) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor.document === event.document) {
                    TranslatePanel.currentPanel.updateContentDebounced(event.document);
                }
            }
        })
    );

    // Listen for document save
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            const config = vscode.workspace.getConfiguration('translatePanel');
            const updateMode = config.get<string>('updateMode', 'onSave');

            if (updateMode === 'onSave' && TranslatePanel.currentPanel) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor.document === document) {
                    TranslatePanel.currentPanel.updateContent(document);
                }
            }
        })
    );
}

export function deactivate() {
    // Cleanup if needed
}
