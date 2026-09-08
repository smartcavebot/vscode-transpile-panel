import * as vscode from 'vscode';
import {
    DocumentSnapshot,
    TextChange,
    TextPosition,
    TextRange,
} from '../../core';

export function toCorePosition(position: vscode.Position): TextPosition {
    return {
        line: position.line,
        character: position.character,
    };
}

export function toCoreRange(range: vscode.Range): TextRange {
    return {
        start: toCorePosition(range.start),
        end: toCorePosition(range.end),
    };
}

export function toCoreDocument(document: vscode.TextDocument): DocumentSnapshot {
    return {
        uri: document.uri.toString(),
        languageId: document.languageId,
        version: document.version,
        text: document.getText(),
    };
}

export function toCoreChange(change: vscode.TextDocumentContentChangeEvent): TextChange {
    return {
        range: toCoreRange(change.range),
        rangeOffset: change.rangeOffset,
        rangeLength: change.rangeLength,
        text: change.text,
    };
}

export function toCoreChanges(event: vscode.TextDocumentChangeEvent): readonly TextChange[] {
    return event.contentChanges.map(toCoreChange);
}

export function toVscodePosition(position: TextPosition): vscode.Position {
    return new vscode.Position(position.line, position.character);
}

export function toVscodeRange(range: TextRange): vscode.Range {
    return new vscode.Range(
        toVscodePosition(range.start),
        toVscodePosition(range.end),
    );
}
