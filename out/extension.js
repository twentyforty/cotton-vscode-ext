"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
// Built-in Cotton directives
const COTTON_BUILTIN_DIRECTIVES = ['vars', 'slot', 'component'];
function activate(context) {
    const definitionProvider = new CottonDefinitionProvider();
    const completionProvider = new CottonCompletionProvider();
    const attributeCompletionProvider = new CottonAttributeCompletionProvider();
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('cotton');
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(['html', 'django-html'], definitionProvider), vscode.languages.registerCompletionItemProvider(['html', 'django-html'], completionProvider, '<' // Trigger character
    ), vscode.languages.registerCompletionItemProvider(['html', 'django-html'], attributeCompletionProvider, ' ', ':', '=' // Trigger characters for attributes
    ), diagnosticCollection);
    // Create and start the diagnostic provider
    const diagnosticProvider = new CottonDiagnosticProvider(diagnosticCollection);
    diagnosticProvider.activate(context);
}
class CottonDefinitionProvider {
    async provideDefinition(document, position, token) {
        const line = document.lineAt(position.line).text;
        const char = position.character;
        // Find the start of the tag before the cursor
        let tagStart = line.lastIndexOf('<', char);
        if (tagStart === -1)
            return undefined;
        // Find the end of the tag
        let tagEnd = line.indexOf('>', tagStart);
        if (tagEnd === -1)
            return undefined;
        // Get the full tag text
        const fullTag = line.substring(tagStart, tagEnd + 1);
        // Check if it's a cotton tag
        if (!fullTag.startsWith('<c-') && !fullTag.startsWith('</c-')) {
            return undefined;
        }
        // Extract just the component name (without < or attributes)
        const componentMatch = fullTag.match(/^<\/?c-([\w.-]+)/);
        if (!componentMatch)
            return undefined;
        const componentName = componentMatch[1]; // This is just the component name without c- prefix
        // Calculate the range for just the component name
        const prefixLength = fullTag.startsWith('</') ? 4 : 3; // Length of "</c-" or "<c-"
        const componentStart = tagStart + prefixLength;
        const componentEnd = componentStart + componentName.length;
        // Create a range that only includes the component name
        const hoverRange = new vscode.Range(new vscode.Position(position.line, componentStart), new vscode.Position(position.line, componentEnd));
        const tagPath = componentName.replace(/\./g, '/');
        const pathVariations = [
            tagPath, // original
            tagPath.replace(/-/g, '_'), // hyphens to underscores
            tagPath.replace(/_/g, '-') // underscores to hyphens
        ];
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder)
            return undefined;
        const config = vscode.workspace.getConfiguration('djangoCotton');
        const templatePaths = config.get('templatePaths', ['templates/cotton']);
        for (const templateBasePath of templatePaths) {
            for (const pathVariation of pathVariations) {
                // First try the direct component.html file
                const templatePath = path.join(workspaceFolder.uri.fsPath, templateBasePath, pathVariation + '.html');
                try {
                    await fs.promises.access(templatePath);
                    return [
                        {
                            originSelectionRange: hoverRange,
                            targetUri: vscode.Uri.file(templatePath),
                            targetRange: new vscode.Range(0, 0, 0, 0),
                            targetSelectionRange: new vscode.Range(0, 0, 0, 0)
                        }
                    ];
                }
                catch {
                    // If component.html doesn't exist, try index.html in the component directory
                    const indexPath = path.join(workspaceFolder.uri.fsPath, templateBasePath, pathVariation, 'index.html');
                    try {
                        await fs.promises.access(indexPath);
                        return [
                            {
                                originSelectionRange: hoverRange,
                                targetUri: vscode.Uri.file(indexPath),
                                targetRange: new vscode.Range(0, 0, 0, 0),
                                targetSelectionRange: new vscode.Range(0, 0, 0, 0)
                            }
                        ];
                    }
                    catch {
                        continue;
                    }
                }
            }
        }
        return undefined;
    }
}
class CottonCompletionProvider {
    async provideCompletionItems(document, position, token) {
        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        // Check if we're in a cotton tag context
        const cottonMatch = linePrefix.match(/<c-([^>]*?)$/);
        if (!cottonMatch) {
            return undefined;
        }
        // Get the partial component name that's been typed (if any)
        const partialName = cottonMatch[1];
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder)
            return undefined;
        const config = vscode.workspace.getConfiguration('djangoCotton');
        const templatePaths = config.get('templatePaths', ['templates/cotton']);
        const completionItems = [];
        for (const templateBasePath of templatePaths) {
            const fullTemplatePath = path.join(workspaceFolder.uri.fsPath, templateBasePath);
            try {
                await this.collectTemplateFiles(fullTemplatePath, '', completionItems);
            }
            catch (error) {
                console.error(`Error scanning directory ${fullTemplatePath}:`, error);
            }
        }
        // Filter items based on what's been typed
        if (partialName) {
            const filteredItems = completionItems.filter(item => item.label.toString().toLowerCase().startsWith(partialName.toLowerCase()));
            return filteredItems;
        }
        return completionItems;
    }
    async collectTemplateFiles(basePath, relativePath, items) {
        try {
            const entries = await fs.promises.readdir(path.join(basePath, relativePath), { withFileTypes: true });
            for (const entry of entries) {
                const currentRelativePath = path.join(relativePath, entry.name);
                if (entry.isDirectory()) {
                    // Check if this directory has an index.html file
                    const indexPath = path.join(basePath, currentRelativePath, 'index.html');
                    try {
                        await fs.promises.access(indexPath);
                        // Create completion item for index.html files
                        const componentName = currentRelativePath
                            .replace(/[\\/]/g, '.') // Replace slashes with dots
                            .replace(/_/g, '-'); // Replace underscores with hyphens
                        const completionItem = new vscode.CompletionItem(componentName, vscode.CompletionItemKind.Snippet);
                        // Add the full tag as the insertion text
                        completionItem.insertText = new vscode.SnippetString(`${componentName}>\${0}</c-${componentName}>`);
                        // Add documentation from the index.html file
                        try {
                            const templateContent = await fs.promises.readFile(indexPath, 'utf-8');
                            const firstLine = templateContent.split('\n')[0].trim();
                            if (firstLine.startsWith('<!--') && firstLine.endsWith('-->')) {
                                completionItem.documentation = new vscode.MarkdownString(firstLine.slice(4, -3).trim());
                            }
                        }
                        catch (error) {
                            console.error(`Error reading index.html file: ${currentRelativePath}`, error);
                        }
                        items.push(completionItem);
                    }
                    catch {
                        // No index.html in this directory, continue
                    }
                    // Recursively scan subdirectories
                    await this.collectTemplateFiles(basePath, currentRelativePath, items);
                }
                else if (entry.isFile() && entry.name.endsWith('.html')) {
                    // Create completion item for HTML files
                    const componentName = currentRelativePath
                        .slice(0, -5) // Remove .html extension
                        .replace(/[\\/]/g, '.') // Replace slashes with dots
                        .replace(/_/g, '-'); // Replace underscores with hyphens
                    const completionItem = new vscode.CompletionItem(componentName, vscode.CompletionItemKind.Snippet);
                    // Add the full tag as the insertion text
                    completionItem.insertText = new vscode.SnippetString(`${componentName}>\${0}</c-${componentName}>`);
                    // Add documentation from the template file
                    try {
                        const templateContent = await fs.promises.readFile(path.join(basePath, currentRelativePath), 'utf-8');
                        const firstLine = templateContent.split('\n')[0].trim();
                        if (firstLine.startsWith('<!--') && firstLine.endsWith('-->')) {
                            completionItem.documentation = new vscode.MarkdownString(firstLine.slice(4, -3).trim());
                        }
                    }
                    catch (error) {
                        console.error(`Error reading template file: ${currentRelativePath}`, error);
                    }
                    items.push(completionItem);
                }
            }
        }
        catch (error) {
            console.error(`Error scanning directory ${basePath}/${relativePath}:`, error);
        }
    }
}
class CottonAttributeCompletionProvider {
    async provideCompletionItems(document, position, token) {
        const line = document.lineAt(position.line).text;
        const char = position.character;
        // Check if we're inside a Cotton component tag
        const beforeCursor = line.substring(0, char);
        // Look for the last Cotton tag opening before the cursor
        // This regex finds: <c-component-name (with any attributes after)
        const tagMatch = beforeCursor.match(/<c-([\w.-]+)(?:\s|>|$)/);
        if (!tagMatch)
            return undefined;
        const componentName = tagMatch[1];
        // Find where this tag starts
        const tagStartIndex = beforeCursor.lastIndexOf(`<c-${componentName}`);
        const afterTagName = beforeCursor.substring(tagStartIndex + `<c-${componentName}`.length);
        // Only provide completions if there's whitespace after the component name
        // This means we're in the attributes area: <c-component |cursor here
        if (!afterTagName.match(/\s/))
            return undefined;
        // Check if we're past the closing tag of this specific opening tag
        // Look for > after our current position that would close this tag
        const restOfLine = line.substring(char);
        const nextClosingTag = restOfLine.indexOf('>');
        // If there's a closing tag and we find a new opening tag before it, 
        // then we're not in this tag anymore
        if (nextClosingTag !== -1) {
            const beforeClosing = restOfLine.substring(0, nextClosingTag);
            if (beforeClosing.includes('<')) {
                return undefined;
            }
        }
        // Get the component file path and parse c-vars
        const componentFilePath = await this.findComponentFile(componentName);
        if (!componentFilePath)
            return undefined;
        const cVars = await this.parseCVars(componentFilePath);
        if (!cVars || cVars.length === 0)
            return undefined;
        // Create completion items for each c-var
        const completionItems = [];
        for (const cVar of cVars) {
            // Create regular parameter completion item
            const regularItem = new vscode.CompletionItem(cVar.name, vscode.CompletionItemKind.Field);
            regularItem.insertText = new vscode.SnippetString(`${cVar.name}="\${1:${cVar.defaultValue || ''}}"`);
            regularItem.documentation = new vscode.MarkdownString(`**${cVar.name}** (text parameter)\n\nDefault: \`${cVar.defaultValue || 'undefined'}\`\n\n🏷️ Cotton component parameter`);
            regularItem.sortText = `0_${cVar.name}`; // High priority sorting
            regularItem.detail = '🏷️ Cotton parameter';
            regularItem.preselect = true; // Preselect Cotton parameters
            regularItem.kind = vscode.CompletionItemKind.Field;
            completionItems.push(regularItem);
            // Create Django expression parameter completion item (with colon)
            const expressionItem = new vscode.CompletionItem(`:${cVar.name}`, vscode.CompletionItemKind.Field);
            expressionItem.insertText = new vscode.SnippetString(`:${cVar.name}="\${1:${cVar.defaultValue || ''}}"`);
            expressionItem.documentation = new vscode.MarkdownString(`**:${cVar.name}** (Django expression parameter)\n\nDefault: \`${cVar.defaultValue || 'undefined'}\`\n\n🔗 Cotton Django expression parameter`);
            expressionItem.sortText = `0_:${cVar.name}`; // High priority sorting
            expressionItem.detail = '🔗 Cotton Django expression';
            expressionItem.preselect = true; // Preselect Cotton parameters
            expressionItem.kind = vscode.CompletionItemKind.Field;
            completionItems.push(expressionItem);
        }
        return completionItems;
    }
    async findComponentFile(componentName) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder)
            return undefined;
        const config = vscode.workspace.getConfiguration('djangoCotton');
        const templatePaths = config.get('templatePaths', ['templates/cotton']);
        const tagPath = componentName.replace(/\./g, '/');
        const pathVariations = [
            tagPath,
            tagPath.replace(/-/g, '_'),
            tagPath.replace(/_/g, '-')
        ];
        for (const templateBasePath of templatePaths) {
            for (const pathVariation of pathVariations) {
                // Try direct file first
                const templatePath = path.join(workspaceFolder.uri.fsPath, templateBasePath, pathVariation + '.html');
                try {
                    await fs.promises.access(templatePath);
                    return templatePath;
                }
                catch {
                    // Try index file
                    const indexPath = path.join(workspaceFolder.uri.fsPath, templateBasePath, pathVariation, 'index.html');
                    try {
                        await fs.promises.access(indexPath);
                        return indexPath;
                    }
                    catch {
                        continue;
                    }
                }
            }
        }
        return undefined;
    }
    async parseCVars(filePath) {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const cVars = [];
            // Match c-vars tag at the beginning of the file
            const cVarsMatch = content.match(/<c-vars\s+([^>]+)>/);
            if (!cVarsMatch)
                return undefined;
            const attributesString = cVarsMatch[1];
            // Parse attributes from the c-vars tag
            // This regex handles: name="value", :name="value", name, :name
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
        }
        catch (error) {
            console.error('Error parsing c-vars:', error);
            return undefined;
        }
    }
}
class CottonDiagnosticProvider {
    constructor(diagnosticCollection) {
        this.diagnosticCollection = diagnosticCollection;
    }
    activate(context) {
        // Listen for document changes
        const onDidChangeTextDocument = vscode.workspace.onDidChangeTextDocument(event => {
            this.updateDiagnostics(event.document);
        });
        // Listen for document opens
        const onDidOpenTextDocument = vscode.workspace.onDidOpenTextDocument(document => {
            this.updateDiagnostics(document);
        });
        // Listen for document saves
        const onDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument(document => {
            this.updateDiagnostics(document);
        });
        // Check all currently open documents
        vscode.workspace.textDocuments.forEach(document => {
            this.updateDiagnostics(document);
        });
        context.subscriptions.push(onDidChangeTextDocument, onDidOpenTextDocument, onDidSaveTextDocument);
    }
    async updateDiagnostics(document) {
        // Only process HTML and Django HTML files
        if (!['html', 'django-html'].includes(document.languageId)) {
            return;
        }
        const diagnostics = [];
        const text = document.getText();
        // Find all Cotton tags in the document
        const cottonTagRegex = /<c-([\w.-]+)(?:\s[^>]*)?(?:\/?>|>)/g;
        let match;
        while ((match = cottonTagRegex.exec(text)) !== null) {
            const componentName = match[1];
            const tagStart = match.index;
            const tagEnd = tagStart + match[0].length;
            // Skip built-in Cotton directives
            if (COTTON_BUILTIN_DIRECTIVES.includes(componentName)) {
                continue;
            }
            // Check if component file exists
            const componentExists = await this.checkComponentExists(componentName);
            if (!componentExists) {
                // Create diagnostic for missing component
                const startPos = document.positionAt(tagStart);
                const endPos = document.positionAt(tagStart + `<c-${componentName}`.length);
                const diagnostic = new vscode.Diagnostic(new vscode.Range(startPos, endPos), `Cotton component '${componentName}' not found. Expected file: ${this.getExpectedPaths(componentName).join(' or ')}`, vscode.DiagnosticSeverity.Error);
                diagnostic.code = 'cotton-component-not-found';
                diagnostic.source = 'Cotton';
                diagnostics.push(diagnostic);
            }
        }
        this.diagnosticCollection.set(document.uri, diagnostics);
    }
    async checkComponentExists(componentName) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder)
            return false;
        const config = vscode.workspace.getConfiguration('djangoCotton');
        const templatePaths = config.get('templatePaths', ['templates/cotton']);
        const tagPath = componentName.replace(/\./g, '/');
        const pathVariations = [
            tagPath,
            tagPath.replace(/-/g, '_'),
            tagPath.replace(/_/g, '-')
        ];
        for (const templateBasePath of templatePaths) {
            for (const pathVariation of pathVariations) {
                // Try direct file first
                const templatePath = path.join(workspaceFolder.uri.fsPath, templateBasePath, pathVariation + '.html');
                try {
                    await fs.promises.access(templatePath);
                    return true;
                }
                catch {
                    // Try index file
                    const indexPath = path.join(workspaceFolder.uri.fsPath, templateBasePath, pathVariation, 'index.html');
                    try {
                        await fs.promises.access(indexPath);
                        return true;
                    }
                    catch {
                        continue;
                    }
                }
            }
        }
        return false;
    }
    getExpectedPaths(componentName) {
        const config = vscode.workspace.getConfiguration('djangoCotton');
        const templatePaths = config.get('templatePaths', ['templates/cotton']);
        const tagPath = componentName.replace(/\./g, '/');
        const paths = [];
        for (const templateBasePath of templatePaths) {
            paths.push(`${templateBasePath}/${tagPath}.html`);
            paths.push(`${templateBasePath}/${tagPath}/index.html`);
        }
        return paths;
    }
}
function deactivate() { }
//# sourceMappingURL=extension.js.map