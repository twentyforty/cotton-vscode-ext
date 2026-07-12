#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    InitializeResult,
    TextDocumentSyncKind,
    CompletionParams,
    DefinitionParams,
    HoverParams,
    ReferenceParams,
    FileChangeType,
    DidChangeConfigurationNotification
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

import { CottonParser } from './cottonParser';
import { ComponentIndex } from './utils/componentIndex';
import { UsageIndex } from './utils/usageIndex';
import { CompletionHandler } from './handlers/completion';
import { DefinitionHandler } from './handlers/definition';
import { DiagnosticsHandler } from './handlers/diagnostics';
import { HoverHandler } from './handlers/hover';
import { ReferencesHandler } from './handlers/references';

const CONFIG_FILE_NAME = 'cotton.config.json';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let workspaceRoot: string;
let parser: CottonParser;
let componentIndex: ComponentIndex;
let usageIndex: UsageIndex;
let completionHandler: CompletionHandler;
let definitionHandler: DefinitionHandler;
let diagnosticsHandler: DiagnosticsHandler;
let hoverHandler: HoverHandler;
let referencesHandler: ReferencesHandler;

interface CottonSettings {
    templatePaths: string[];
}

const defaultSettings: CottonSettings = {
    templatePaths: ['templates/cotton']
};

let globalSettings: CottonSettings = defaultSettings;
let hasConfigurationCapability = false;
let initOptions: Partial<CottonSettings> = {};

connection.onInitialize((params: InitializeParams): InitializeResult => {
    hasConfigurationCapability = !!(
        params.capabilities.workspace?.configuration
    );

    // Store initialization options from LSP client (Neovim, Sublime, etc.)
    initOptions = (params.initializationOptions as Partial<CottonSettings>) || {};

    workspaceRoot = params.workspaceFolders?.[0]?.uri 
        ? URI.parse(params.workspaceFolders[0].uri).fsPath
        : params.rootUri 
            ? URI.parse(params.rootUri).fsPath
            : process.cwd();

    parser = new CottonParser();
    componentIndex = new ComponentIndex(workspaceRoot, defaultSettings.templatePaths);
    usageIndex = new UsageIndex(workspaceRoot);
    completionHandler = new CompletionHandler(parser, componentIndex);
    definitionHandler = new DefinitionHandler(parser, componentIndex);
    diagnosticsHandler = new DiagnosticsHandler(parser, componentIndex);
    hoverHandler = new HoverHandler(parser, componentIndex);
    referencesHandler = new ReferencesHandler(parser, componentIndex, usageIndex);

    usageIndex.onChange(() => { notifyUnusedComponents(); });

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: ['<', ' ', ':', '=', '"']
            },
            definitionProvider: true,
            hoverProvider: true,
            referencesProvider: true
        }
    };
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    updateConfiguration();

    // Kick off the one-time full workspace usage scan in the background - it's not
    // needed to answer completion/definition/hover requests, only references and the
    // unused-component decorations, so there's no reason to block startup on it.
    usageIndex.ensureBuilt();
});

/**
 * Push the current list of unused component file paths to the client, which renders
 * them as file-explorer decorations. Called after the initial scan and after every
 * incremental update, but each call is cheap (see UsageIndex benchmarks).
 */
async function notifyUnusedComponents(): Promise<void> {
    const allComponents = await componentIndex.getAllComponents();
    const unusedPaths = usageIndex.getUnusedComponentPaths(allComponents);
    connection.sendNotification('cotton/unusedComponents', {
        uris: unusedPaths.map(p => URI.file(p).toString())
    });
}

/**
 * Load settings with priority:
 * 1. Editor configuration (VS Code settings.json)
 * 2. LSP initialization options (Neovim, Sublime, etc.)
 * 3. Project config file (cotton.config.json)
 * 4. Default settings
 */
async function updateConfiguration() {
    let settings: CottonSettings = { ...defaultSettings };

    // Try project config file first (lowest priority that overrides defaults)
    const fileConfig = await loadProjectConfig();
    if (fileConfig?.templatePaths) {
        settings.templatePaths = fileConfig.templatePaths;
    }

    // LSP initialization options override file config
    if (initOptions.templatePaths) {
        settings.templatePaths = initOptions.templatePaths;
    }

    // Editor configuration has highest priority
    if (hasConfigurationCapability) {
        const editorConfig = await connection.workspace.getConfiguration('djangoCotton');
        if (editorConfig?.templatePaths) {
            settings.templatePaths = editorConfig.templatePaths;
        }
    }

    globalSettings = settings;
    componentIndex.updateSettings(globalSettings.templatePaths);
}

/**
 * Load configuration from cotton.config.json in the workspace root
 */
async function loadProjectConfig(): Promise<Partial<CottonSettings> | null> {
    const configPath = path.join(workspaceRoot, CONFIG_FILE_NAME);
    
    try {
        const content = await fs.promises.readFile(configPath, 'utf-8');
        const config = JSON.parse(content);
        
        // Validate the config
        if (config && typeof config === 'object') {
            const result: Partial<CottonSettings> = {};
            
            if (Array.isArray(config.templatePaths)) {
                result.templatePaths = config.templatePaths.filter(
                    (p: unknown) => typeof p === 'string'
                );
            }
            
            return result;
        }
    } catch {
        // Config file doesn't exist or is invalid - that's fine
    }
    
    return null;
}

connection.onDidChangeConfiguration(async () => {
    await updateConfiguration();
    documents.all().forEach(validateDocument);
});

connection.onCompletion(async (params: CompletionParams) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    return completionHandler.handleCompletion(document, params.position);
});

connection.onDefinition(async (params: DefinitionParams) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    return definitionHandler.handleDefinition(document, params.position);
});

connection.onHover(async (params: HoverParams) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    return hoverHandler.handleHover(document, params.position);
});

connection.onReferences(async (params: ReferenceParams) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    return referencesHandler.handleReferences(document, params.position, params.context.includeDeclaration);
});

/**
 * Custom request (not part of the LSP spec) backing the Explorer "Find All References"
 * context-menu command: given a component *file*, rather than a cursor position inside a
 * usage, return every place that component is used across the workspace.
 */
connection.onRequest('cotton/referencesForFile', async ({ uri }: { uri: string }) => {
    const filePath = path.normalize(URI.parse(uri).fsPath);
    const allComponents = await componentIndex.getAllComponents();
    const match = allComponents.find(c => path.normalize(c.filePath) === filePath);
    if (!match) return [];

    await usageIndex.ensureBuilt();
    return usageIndex.getReferences(match.name);
});

connection.onRequest('cotton/getUnusedComponents', async () => {
    const allComponents = await componentIndex.getAllComponents();
    const unusedPaths = usageIndex.getUnusedComponentPaths(allComponents);
    return { uris: unusedPaths.map(p => URI.file(p).toString()) };
});

async function validateDocument(document: TextDocument): Promise<void> {
    const diagnostics = await diagnosticsHandler.getDiagnostics(document);
    connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

documents.onDidOpen(event => validateDocument(event.document));
documents.onDidChangeContent(event => {
    // Keep the usage index in sync as the user types - this only rescans the one
    // changed document (cheap), not the whole workspace.
    usageIndex.updateFile(event.document.uri, event.document.getText());
    validateDocument(event.document);
});
documents.onDidSave(async event => {
    // Check if the config file was saved
    const savedPath = URI.parse(event.document.uri).fsPath;
    if (path.basename(savedPath) === CONFIG_FILE_NAME) {
        await updateConfiguration();
    }
    
    componentIndex.invalidateCache();
    validateDocument(event.document);
});
documents.onDidClose(event => {
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

/**
 * The client watches every .html file in the workspace via a FileSystemWatcher (see
 * src/client/extension.ts) and forwards changes here even for files that were never opened
 * in an editor - e.g. created, edited, or deleted via git, a terminal, or another tool.
 * Without this, both the component index and the usage index (and therefore unused-component
 * detection) would silently drift out of sync with the filesystem until something happened
 * to be opened/saved in the editor.
 */
connection.onDidChangeWatchedFiles(async params => {
    let changed = false;

    for (const change of params.changes) {
        if (change.type === FileChangeType.Deleted) {
            usageIndex.removeFile(change.uri);
            changed = true;
            continue;
        }

        try {
            const filePath = URI.parse(change.uri).fsPath;
            const content = await fs.promises.readFile(filePath, 'utf-8');
            usageIndex.updateFile(change.uri, content);
            changed = true;
        } catch {
            // File may have been removed/renamed between the event and this read - skip it.
        }
    }

    if (changed) {
        componentIndex.invalidateCache();
        documents.all().forEach(validateDocument);
    }
});

documents.listen(connection);
connection.listen();
