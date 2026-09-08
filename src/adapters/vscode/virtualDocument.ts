import * as vscode from 'vscode';

export const PROJECTION_SCHEME = 'vscode-transpile';

/**
 * In-memory readonly target documents. VS Code owns the editor surface; this provider owns only
 * the text backing each projection URI.
 */
export class ProjectionDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
    private readonly documents = new Map<string, string>();

    readonly onDidChange = this.emitter.event;

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.documents.get(uri.toString()) ?? '';
    }

    update(uri: vscode.Uri, text: string): void {
        const key = uri.toString();
        if (this.documents.get(key) === text) {
            return;
        }
        this.documents.set(key, text);
        this.emitter.fire(uri);
    }

    delete(uri: vscode.Uri): void {
        this.documents.delete(uri.toString());
    }

    dispose(): void {
        this.documents.clear();
        this.emitter.dispose();
    }
}

export function createProjectionUri(source: vscode.Uri, targetLanguage: string): vscode.Uri {
    const safeTarget = targetLanguage.replace(/[^a-zA-Z0-9._-]+/g, '-');
    const sourceName = source.path.split('/').filter(Boolean).pop() ?? 'untitled';
    return vscode.Uri.from({
        scheme: PROJECTION_SCHEME,
        path: `/${sourceName}.${safeTarget || 'target'}`,
        query: `source=${encodeURIComponent(source.toString())}`,
    });
}
