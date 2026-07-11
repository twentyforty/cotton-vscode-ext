import * as vscode from 'vscode';

/**
 * Renders a small badge in the file explorer on Cotton component files that have zero
 * usages anywhere in the workspace, per the server's UsageIndex. The actual scanning happens
 * server-side (see src/server/utils/usageIndex.ts); this class only renders the result the
 * server already computed - it does no filesystem scanning of its own.
 */
export class UnusedComponentDecorationProvider implements vscode.FileDecorationProvider {
    private unusedUris = new Set<string>();

    private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this.emitter.event;

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (!this.unusedUris.has(uri.toString())) {
            return undefined;
        }

        return {
            badge: 'U',
            tooltip: 'Unused Cotton component (no <c-...> usages found in the workspace)',
            color: new vscode.ThemeColor('list.deemphasizedForeground')
        };
    }

    update(unusedUris: string[]): void {
        const changedUris = new Set([...this.unusedUris, ...unusedUris].map(u => vscode.Uri.parse(u)));
        this.unusedUris = new Set(unusedUris);
        this.emitter.fire([...changedUris]);
    }
}
