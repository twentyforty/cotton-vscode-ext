import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Built-in Cotton directives
const COTTON_BUILTIN_DIRECTIVES = ['vars', 'slot', 'component'];

// Shared utilities
class CottonUtils {
    static getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
        return vscode.workspace.workspaceFolders?.[0];
    }

    static getTemplatePaths(): string[] {
        const config = vscode.workspace.getConfiguration('djangoCotton');
        return config.get<string[]>('templatePaths', ['templates/cotton']);
    }

    static getPathVariations(componentName: string): string[] {
        const tagPath = componentName.replace(/\./g, '/');
        return [
            tagPath,                    // original
            tagPath.replace(/-/g, '_'), // hyphens to underscores
            tagPath.replace(/_/g, '-')  // underscores to hyphens
        ];
    }

    static async findComponentFile(componentName: string): Promise<string | undefined> {
        const workspaceFolder = this.getWorkspaceFolder();
        if (!workspaceFolder) return undefined;

        const templatePaths = this.getTemplatePaths();
        const pathVariations = this.getPathVariations(componentName);

        for (const templateBasePath of templatePaths) {
            for (const pathVariation of pathVariations) {
                // Try direct file first
                const templatePath = path.join(
                    workspaceFolder.uri.fsPath,
                    templateBasePath,
                    pathVariation + '.html'
                );

                try {
                    await fs.promises.access(templatePath);
                    return templatePath;
                } catch {
                    // Try index file
                    const indexPath = path.join(
                        workspaceFolder.uri.fsPath,
                        templateBasePath,
                        pathVariation,
                        'index.html'
                    );

                    try {
                        await fs.promises.access(indexPath);
                        return indexPath;
                    } catch {
                        continue;
                    }
                }
            }
        }

        return undefined;
    }

    static findCottonComponentAtPosition(document: vscode.TextDocument, position: vscode.Position): { componentName: string; range: vscode.Range } | undefined {
        const line = document.lineAt(position.line).text;
        const char = position.character;

        // Look for c- pattern around the cursor position
        // This regex finds "c-" followed by component name characters
        const cottonPattern = /c-([\w.-]+)/g;
        let match;

        while ((match = cottonPattern.exec(line)) !== null) {
            const matchStart = match.index;
            const matchEnd = matchStart + match[0].length;
            
            // Check if cursor is within this match
            if (char >= matchStart && char <= matchEnd) {
                const componentName = match[1];
                
                // Create range for just the component name (after "c-")
                const nameStart = matchStart + 2; // Skip "c-"
                const nameEnd = nameStart + componentName.length;
                
                return {
                    componentName,
                    range: new vscode.Range(
                        new vscode.Position(position.line, nameStart),
                        new vscode.Position(position.line, nameEnd)
                    )
                };
            }
        }

        return undefined;
    }
}

interface CVarDefinition {
    name: string;
    defaultValue: string;
    isDjangoExpression: boolean;
}

export function activate(context: vscode.ExtensionContext) {
    const definitionProvider = new CottonDefinitionProvider();
    const completionProvider = new CottonCompletionProvider();
    const attributeCompletionProvider = new CottonAttributeCompletionProvider();
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('cotton');

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            ['html', 'django-html'],
            definitionProvider
        ),
        vscode.languages.registerCompletionItemProvider(
            ['html', 'django-html'],
            completionProvider,
            '<' // Trigger character
        ),
        vscode.languages.registerCompletionItemProvider(
            ['html', 'django-html'],
            attributeCompletionProvider,
            ' ', ':', '=' // Trigger characters for attributes
        ),
        diagnosticCollection
    );

    // Create and start the diagnostic provider
    const diagnosticProvider = new CottonDiagnosticProvider(diagnosticCollection);
    diagnosticProvider.activate(context);
}

class CottonDefinitionProvider implements vscode.DefinitionProvider {
    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.DefinitionLink[] | undefined> {
        // Find Cotton component at cursor position
        const componentInfo = CottonUtils.findCottonComponentAtPosition(document, position);
        if (!componentInfo) return undefined;

        const { componentName, range } = componentInfo;

        // Find the component file
        const componentFilePath = await CottonUtils.findComponentFile(componentName);
        if (!componentFilePath) return undefined;

        return [
            {
                originSelectionRange: range,
                targetUri: vscode.Uri.file(componentFilePath),
                targetRange: new vscode.Range(0, 0, 0, 0),
                targetSelectionRange: new vscode.Range(0, 0, 0, 0)
            }
        ];
    }
}

class CottonCompletionProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.CompletionItem[] | undefined> {
        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        
        // Check if we're in a cotton tag context
        const cottonMatch = linePrefix.match(/<c-([^>]*?)$/);
        if (!cottonMatch) {
            return undefined;
        }

        // Get the partial component name that's been typed (if any)
        const partialName = cottonMatch[1];

        const workspaceFolder = CottonUtils.getWorkspaceFolder();
        if (!workspaceFolder) return undefined;

        const templatePaths = CottonUtils.getTemplatePaths();
        const completionItems: vscode.CompletionItem[] = [];

        for (const templateBasePath of templatePaths) {
            const fullTemplatePath = path.join(workspaceFolder.uri.fsPath, templateBasePath);
            
            try {
                await this.collectTemplateFiles(fullTemplatePath, '', completionItems);
            } catch (error) {
                console.error(`Error scanning directory ${fullTemplatePath}:`, error);
            }
        }

        // Filter items based on what's been typed
        if (partialName) {
            const filteredItems = completionItems.filter(item => 
                item.label.toString().toLowerCase().startsWith(partialName.toLowerCase())
            );
            return filteredItems;
        }

        return completionItems;
    }

    private async collectTemplateFiles(
        basePath: string,
        relativePath: string,
        items: vscode.CompletionItem[]
    ): Promise<void> {
        try {
            const entries = await fs.promises.readdir(path.join(basePath, relativePath), { withFileTypes: true });

            for (const entry of entries) {
                const currentRelativePath = path.join(relativePath, entry.name);

                if (entry.isDirectory()) {
                    // Check if this directory has an index.html file
                    const indexPath = path.join(basePath, currentRelativePath, 'index.html');
                    try {
                        await fs.promises.access(indexPath);
                        const componentName = currentRelativePath
                            .replace(/[\\/]/g, '.') // Replace slashes with dots
                            .replace(/_/g, '-'); // Replace underscores with hyphens

                        const completionItem = this.createCompletionItem(componentName, indexPath);
                        items.push(completionItem);
                    } catch {
                        // No index.html in this directory, continue
                    }

                    // Recursively scan subdirectories
                    await this.collectTemplateFiles(basePath, currentRelativePath, items);
                } else if (entry.isFile() && entry.name.endsWith('.html')) {
                    // Create completion item for HTML files
                    const componentName = currentRelativePath
                        .slice(0, -5) // Remove .html extension
                        .replace(/[\\/]/g, '.') // Replace slashes with dots
                        .replace(/_/g, '-'); // Replace underscores with hyphens

                    const completionItem = this.createCompletionItem(
                        componentName,
                        path.join(basePath, currentRelativePath)
                    );
                    items.push(completionItem);
                }
            }
        } catch (error) {
            console.error(`Error scanning directory ${basePath}/${relativePath}:`, error);
        }
    }

    private createCompletionItem(componentName: string, filePath: string): vscode.CompletionItem {
        const completionItem = new vscode.CompletionItem(
            componentName,
            vscode.CompletionItemKind.Snippet
        );

        // Add the full tag as the insertion text
        completionItem.insertText = new vscode.SnippetString(`${componentName}>\${0}</c-${componentName}>`);
        
        // Add documentation from the template file
        this.addDocumentation(completionItem, filePath);

        return completionItem;
    }

    private async addDocumentation(item: vscode.CompletionItem, filePath: string): Promise<void> {
        try {
            const templateContent = await fs.promises.readFile(filePath, 'utf-8');
            const firstLine = templateContent.split('\n')[0].trim();
            if (firstLine.startsWith('<!--') && firstLine.endsWith('-->')) {
                item.documentation = new vscode.MarkdownString(firstLine.slice(4, -3).trim());
            }
        } catch (error) {
            console.error(`Error reading template file: ${filePath}`, error);
        }
    }
}

class CottonAttributeCompletionProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.CompletionItem[] | undefined> {
        const line = document.lineAt(position.line).text;
        const char = position.character;

        // Check if we're inside a Cotton component tag
        const beforeCursor = line.substring(0, char);
        
        // Look for the last Cotton tag opening before the cursor
        const tagMatch = beforeCursor.match(/<c-([\w.-]+)(?:\s|>|$)/);
        if (!tagMatch) return undefined;

        const componentName = tagMatch[1];
        
        // Find where this tag starts
        const tagStartIndex = beforeCursor.lastIndexOf(`<c-${componentName}`);
        const afterTagName = beforeCursor.substring(tagStartIndex + `<c-${componentName}`.length);
        
        // Only provide completions if there's whitespace after the component name
        if (!afterTagName.match(/\s/)) return undefined;
        
        // Check if we're past the closing tag
        const restOfLine = line.substring(char);
        const nextClosingTag = restOfLine.indexOf('>');
        
        if (nextClosingTag !== -1) {
            const beforeClosing = restOfLine.substring(0, nextClosingTag);
            if (beforeClosing.includes('<')) {
                return undefined;
            }
        }
        
        // Get the component file path and parse c-vars
        const componentFilePath = await CottonUtils.findComponentFile(componentName);
        if (!componentFilePath) return undefined;

        const cVars = await this.parseCVars(componentFilePath);
        if (!cVars || cVars.length === 0) return undefined;

        // Parse existing attributes to avoid duplicates
        const existingAttributes = this.parseExistingAttributes(beforeCursor, componentName);

        // Create completion items for each c-var
        const completionItems: vscode.CompletionItem[] = [];
        
        for (const cVar of cVars) {
            // Regular parameter
            if (!existingAttributes.has(cVar.name)) {
                const regularItem = this.createAttributeCompletionItem(cVar, false);
                completionItems.push(regularItem);
            }

            // Django expression parameter
            if (!existingAttributes.has(`:${cVar.name}`)) {
                const expressionItem = this.createAttributeCompletionItem(cVar, true);
                completionItems.push(expressionItem);
            }
        }

        return completionItems;
    }

    private createAttributeCompletionItem(cVar: CVarDefinition, isDjangoExpression: boolean): vscode.CompletionItem {
        const prefix = isDjangoExpression ? ':' : '';
        const name = `${prefix}${cVar.name}`;
        
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
        item.insertText = new vscode.SnippetString(`${name}="\${1:${cVar.defaultValue || ''}}"`);
        
        const type = isDjangoExpression ? 'Django expression parameter' : 'text parameter';
        const icon = isDjangoExpression ? '🔗' : '🏷️';
        
        item.documentation = new vscode.MarkdownString(
            `**${name}** (${type})\n\nDefault: \`${cVar.defaultValue || 'undefined'}\`\n\n${icon} Cotton component parameter`
        );
        item.sortText = `0_${name}`;
        item.detail = `${icon} Cotton ${isDjangoExpression ? 'expression' : 'parameter'}`;
        item.preselect = true;

        return item;
    }

    private parseExistingAttributes(beforeCursor: string, componentName: string): Set<string> {
        const existingAttributes = new Set<string>();
        
        const tagStartIndex = beforeCursor.lastIndexOf(`<c-${componentName}`);
        if (tagStartIndex === -1) return existingAttributes;
        
        const tagContent = beforeCursor.substring(tagStartIndex);
        const attributeRegex = /\s+(:?)(\w+)(?:=["'][^"']*["'])?/g;
        let match;
        
        while ((match = attributeRegex.exec(tagContent)) !== null) {
            const hasColon = match[1] === ':';
            const attrName = match[2];
            
            existingAttributes.add(hasColon ? `:${attrName}` : attrName);
        }
        
        return existingAttributes;
    }

    private async parseCVars(filePath: string): Promise<CVarDefinition[] | undefined> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const cVars: CVarDefinition[] = [];

            const cVarsMatch = content.match(/<c-vars\s+([^>]+)>/);
            if (!cVarsMatch) return undefined;

            const attributesString = cVarsMatch[1];
            const attributeRegex = /(:?)(\w+)(?:=["']([^"']*)["'])?/g;
            let match;

            while ((match = attributeRegex.exec(attributesString)) !== null) {
                const hasColon = match[1] === ':';
                const name = match[2];
                const defaultValue = match[3] || '';
                
                cVars.push({
                    name,
                    defaultValue,
                    isDjangoExpression: hasColon
                });
            }

            return cVars;
        } catch (error) {
            console.error('Error parsing c-vars:', error);
            return undefined;
        }
    }
}

class CottonDiagnosticProvider {
    private diagnosticCollection: vscode.DiagnosticCollection;

    constructor(diagnosticCollection: vscode.DiagnosticCollection) {
        this.diagnosticCollection = diagnosticCollection;
    }

    public activate(context: vscode.ExtensionContext) {
        const onDidChangeTextDocument = vscode.workspace.onDidChangeTextDocument(event => {
            this.updateDiagnostics(event.document);
        });

        const onDidOpenTextDocument = vscode.workspace.onDidOpenTextDocument(document => {
            this.updateDiagnostics(document);
        });

        const onDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument(document => {
            this.updateDiagnostics(document);
        });

        vscode.workspace.textDocuments.forEach(document => {
            this.updateDiagnostics(document);
        });

        context.subscriptions.push(
            onDidChangeTextDocument,
            onDidOpenTextDocument,
            onDidSaveTextDocument
        );
    }

    private async updateDiagnostics(document: vscode.TextDocument) {
        if (!['html', 'django-html'].includes(document.languageId)) {
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();
        
        const cottonTagRegex = /<c-([\w.-]+)(?:\s[^>]*)?(?:\/?>|>)/g;
        let match;

        while ((match = cottonTagRegex.exec(text)) !== null) {
            const componentName = match[1];
            const tagStart = match.index;

            if (COTTON_BUILTIN_DIRECTIVES.includes(componentName)) {
                continue;
            }

            const componentExists = await CottonUtils.findComponentFile(componentName);
            
            if (!componentExists) {
                const startPos = document.positionAt(tagStart);
                const endPos = document.positionAt(tagStart + `<c-${componentName}`.length);
                
                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(startPos, endPos),
                    `Cotton component '${componentName}' not found. Expected file: ${this.getExpectedPaths(componentName).join(' or ')}`,
                    vscode.DiagnosticSeverity.Error
                );
                
                diagnostic.code = 'cotton-component-not-found';
                diagnostic.source = 'Cotton';
                diagnostics.push(diagnostic);
            }
        }

        this.diagnosticCollection.set(document.uri, diagnostics);
    }

    private getExpectedPaths(componentName: string): string[] {
        const templatePaths = CottonUtils.getTemplatePaths();
        const tagPath = componentName.replace(/\./g, '/');
        const paths: string[] = [];
        
        for (const templateBasePath of templatePaths) {
            paths.push(`${templateBasePath}/${tagPath}.html`);
            paths.push(`${templateBasePath}/${tagPath}/index.html`);
        }
        
        return paths;
    }
}

export function deactivate() {}