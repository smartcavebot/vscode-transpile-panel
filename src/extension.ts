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
    // Account for VS Code editor scroll behavior:
    // Editor scrolls until last line is at TOP (extra page of scroll)
    // Preview scrolls until last line is at BOTTOM (standard web scroll)
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
            if (TranslatePanel.currentPanel && event.visibleRanges.length > 0) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor === event.textEditor) {
                    const firstVisibleLine = event.visibleRanges[0].start.line;
                    const lastVisibleLine = event.visibleRanges[0].end.line;
                    const visibleLineCount = lastVisibleLine - firstVisibleLine;
                    const totalLines = activeEditor.document.lineCount;

                    // Editor's effective scroll range ends when last line reaches top
                    // which is (totalLines - 1). But we want to map to preview's range
                    // where scroll ends when last line reaches bottom.
                    // Adjusted max: totalLines - visibleLineCount (approximately)
                    const effectiveMax = Math.max(1, totalLines - visibleLineCount);
                    const percentage = Math.min(1, firstVisibleLine / effectiveMax);

                    TranslatePanel.currentPanel.syncScroll(percentage);
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
