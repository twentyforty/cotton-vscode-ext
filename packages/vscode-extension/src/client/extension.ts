import * as vscode from 'vscode';
import { ExtensionContext } from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';
import { UnusedComponentDecorationProvider } from './unusedComponentDecorations';

let client: LanguageClient;

function getServerModule(): string {
    return require.resolve('django-cotton-lsp/out/server.js');
}

export function activate(context: ExtensionContext) {
    const serverModule = getServerModule();

    // Server options - run the server as a separate Node process
    const serverOptions: ServerOptions = {
        run: {
            module: serverModule,
            transport: TransportKind.ipc
        },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: {
                execArgv: ['--nolazy', '--inspect=6009']
            }
        }
    };

    // Watch all HTML files on disk (not just open editors) so the server's component and
    // usage indexes stay accurate even for files changed outside VS Code (git, terminal, etc).
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.html');
    context.subscriptions.push(fileWatcher);

    // Client options - which documents the server handles
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'html' },
            { scheme: 'file', language: 'django-html' }
        ],
        synchronize: {
            fileEvents: fileWatcher
        }
    };

    // Create and start the client
    client = new LanguageClient(
        'djangoCotton',
        'Django Cotton Language Server',
        serverOptions,
        clientOptions
    );

    const decorationProvider = new UnusedComponentDecorationProvider();
    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(decorationProvider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('djangoCotton.findComponentUsages', async (uri?: vscode.Uri) => {
            const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) return;

            const locations = await client.sendRequest<{ uri: string; range: vscode.Range }[]>(
                'cotton/referencesForFile',
                { uri: targetUri.toString() }
            );

            if (!locations || locations.length === 0) {
                vscode.window.showInformationMessage('No usages of this Cotton component were found in the workspace.');
                return;
            }

            const vscodeLocations = locations.map(loc => new vscode.Location(
                vscode.Uri.parse(loc.uri),
                new vscode.Range(
                    loc.range.start.line, loc.range.start.character,
                    loc.range.end.line, loc.range.end.character
                )
            ));

            await vscode.commands.executeCommand(
                'editor.action.showReferences',
                targetUri,
                new vscode.Position(0, 0),
                vscodeLocations
            );
        })
    );

    // Start the client (also launches the server)
    client.start().then(() => {
        client.onNotification('cotton/unusedComponents', (params: { uris: string[] }) => {
            decorationProvider.update(params.uris);
        });
    });
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
