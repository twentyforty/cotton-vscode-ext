"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const COTTON_BUILTIN_DIRECTIVES = ['vars', 'slot', 'component'];
function activate(context) {
    const definitionProvider = new CottonDefinitionProvider();
    const completionProvider = new CottonCompletionProvider();
    const attributeCompletionProvider = new CottonAttributeCompletionProvider();
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('cotton');
    const diagnosticProvider = new CottonDiagnosticProvider(diagnosticCollection);
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(['html', 'django-html'], definitionProvider), vscode.languages.registerCompletionItemProvider(['html', 'django-html'], completionProvider, '<'), vscode.languages.registerCompletionItemProvider(['html', 'django-html'], attributeCompletionProvider, ' ', ':', '='), diagnosticCollection);
    diagnosticProvider.activate(context);
}
// Shared utility functions
function getWorkspaceFolder() {
    return vscode.workspace.workspaceFolders?.[0];
}
function getTemplatePaths() {
    const config = vscode.workspace.getConfiguration('djangoCotton');
    return config.get('templatePaths', ['templates/cotton']);
}
async function findComponentFile(componentName) {
    const workspaceFolder = getWorkspaceFolder();
    if (!workspaceFolder)
        return undefined;
    const templatePaths = getTemplatePaths();
    const tagPath = componentName.replace(/\./g, '/');
    const pathVariations = [
        tagPath,
        tagPath.replace(/-/g, '_'),
        tagPath.replace(/_/g, '-')
    ];
    for (const templateBasePath of templatePaths) {
        for (const pathVariation of pathVariations) {
            // Try direct file
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
// Go-to-definition provider
class CottonDefinitionProvider {
    async provideDefinition(document, position) {
        const componentInfo = this.findCottonComponentAtPosition(document, position);
        if (!componentInfo)
            return undefined;
        const componentFilePath = await findComponentFile(componentInfo.componentName);
        if (!componentFilePath)
            return undefined;
        return [{
                originSelectionRange: componentInfo.range,
                targetUri: vscode.Uri.file(componentFilePath),
                targetRange: new vscode.Range(0, 0, 0, 0),
                targetSelectionRange: new vscode.Range(0, 0, 0, 0)
            }];
    }
    findCottonComponentAtPosition(document, position) {
        const line = document.lineAt(position.line).text;
        const char = position.character;
        const cottonPattern = /c-([\w.-]+)/g;
        let match;
        while ((match = cottonPattern.exec(line)) !== null) {
            const matchStart = match.index;
            const matchEnd = matchStart + match[0].length;
            if (char >= matchStart && char <= matchEnd) {
                const componentName = match[1];
                const nameStart = matchStart + 2; // Skip "c-"
                const nameEnd = nameStart + componentName.length;
                return {
                    componentName,
                    range: new vscode.Range(new vscode.Position(position.line, nameStart), new vscode.Position(position.line, nameEnd))
                };
            }
        }
        return undefined;
    }
}
// Tag completion provider
class CottonCompletionProvider {
    async provideCompletionItems(document, position) {
        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        const cottonMatch = linePrefix.match(/<c-([^>]*?)$/);
        if (!cottonMatch)
            return undefined;
        const partialName = cottonMatch[1];
        const workspaceFolder = getWorkspaceFolder();
        if (!workspaceFolder)
            return undefined;
        const completionItems = [];
        const templatePaths = getTemplatePaths();
        for (const templateBasePath of templatePaths) {
            const fullTemplatePath = path.join(workspaceFolder.uri.fsPath, templateBasePath);
            try {
                await this.collectTemplateFiles(fullTemplatePath, '', completionItems);
            }
            catch (error) {
                console.error(`Error scanning directory ${fullTemplatePath}:`, error);
            }
        }
        // Filter based on what's been typed
        if (partialName) {
            return completionItems.filter(item => item.label.toString().toLowerCase().startsWith(partialName.toLowerCase()));
        }
        return completionItems;
    }
    async collectTemplateFiles(basePath, relativePath, items) {
        try {
            const entries = await fs.promises.readdir(path.join(basePath, relativePath), { withFileTypes: true });
            for (const entry of entries) {
                const currentRelativePath = path.join(relativePath, entry.name);
                if (entry.isDirectory()) {
                    const indexPath = path.join(basePath, currentRelativePath, 'index.html');
                    try {
                        await fs.promises.access(indexPath);
                        const componentName = currentRelativePath.replace(/[\\/]/g, '.').replace(/_/g, '-');
                        items.push(this.createCompletionItem(componentName, indexPath));
                    }
                    catch { }
                    await this.collectTemplateFiles(basePath, currentRelativePath, items);
                }
                else if (entry.isFile() && entry.name.endsWith('.html')) {
                    const componentName = currentRelativePath.slice(0, -5).replace(/[\\/]/g, '.').replace(/_/g, '-');
                    items.push(this.createCompletionItem(componentName, path.join(basePath, currentRelativePath)));
                }
            }
        }
        catch (error) {
            console.error(`Error scanning directory ${basePath}/${relativePath}:`, error);
        }
    }
    createCompletionItem(componentName, filePath) {
        const item = new vscode.CompletionItem(componentName, vscode.CompletionItemKind.Snippet);
        item.insertText = new vscode.SnippetString(componentName);
        // Add documentation from template file
        this.addDocumentation(item, filePath);
        return item;
    }
    async addDocumentation(item, filePath) {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const firstLine = content.split('\n')[0].trim();
            if (firstLine.startsWith('<!--') && firstLine.endsWith('-->')) {
                item.documentation = new vscode.MarkdownString(firstLine.slice(4, -3).trim());
            }
        }
        catch { }
    }
}
// Attribute completion provider
class CottonAttributeCompletionProvider {
    async provideCompletionItems(document, position) {
        // Find if we're inside a Cotton component tag (potentially multi-line)
        const tagContext = this.findCottonTagContext(document, position);
        if (!tagContext?.isInsideTag)
            return undefined;
        const componentName = tagContext.componentName;
        // Get component file and parse c-vars
        const componentFilePath = await findComponentFile(componentName);
        if (!componentFilePath)
            return undefined;
        const cVars = await this.parseCVars(componentFilePath);
        if (!cVars?.length)
            return undefined;
        // Get existing attributes  
        const existingAttributes = this.parseExistingAttributes(document, position, componentName);
        // Detect partial parameter typing
        const line = document.lineAt(position.line).text;
        const partialInfo = this.getPartialParameterAtPosition(line, position.character, position.line);
        const completionItems = [];
        for (const cVar of cVars) {
            // Regular parameter
            if (!existingAttributes.has(cVar.name)) {
                if (!partialInfo || cVar.name.toLowerCase().startsWith(partialInfo.alreadyTyped.toLowerCase())) {
                    completionItems.push(this.createAttributeItem(cVar, false, partialInfo));
                }
            }
            // Django expression parameter
            const expressionName = `:${cVar.name}`;
            if (!existingAttributes.has(expressionName)) {
                if (!partialInfo || expressionName.toLowerCase().startsWith(partialInfo.alreadyTyped.toLowerCase())) {
                    completionItems.push(this.createAttributeItem(cVar, true, partialInfo));
                }
            }
        }
        return completionItems;
    }
    findCottonTagContext(document, position) {
        const documentText = document.getText();
        const offset = document.offsetAt(position);
        // Look backwards from cursor to find the most recent Cotton tag opening
        const textBeforeCursor = documentText.substring(0, offset);
        // Find all Cotton tag openings before the cursor
        const tagOpeningRegex = /<c-([\w.-]+)/g;
        let lastTagMatch = null;
        let match;
        while ((match = tagOpeningRegex.exec(textBeforeCursor)) !== null) {
            lastTagMatch = match;
        }
        if (!lastTagMatch)
            return undefined;
        const componentName = lastTagMatch[1];
        const tagStartOffset = lastTagMatch.index;
        // Find the closing > of this tag
        const afterTagStart = documentText.substring(tagStartOffset);
        const closingBracketMatch = afterTagStart.match(/>/);
        if (!closingBracketMatch) {
            // No closing > found, we're definitely inside the tag
            return { componentName, isInsideTag: true };
        }
        const closingBracketOffset = tagStartOffset + closingBracketMatch.index;
        // Check if cursor is before the closing >
        if (offset <= closingBracketOffset) {
            return { componentName, isInsideTag: true };
        }
        return undefined; // Not inside a tag
    }
    createAttributeItem(cVar, isDjangoExpression, partialInfo) {
        const fullName = isDjangoExpression ? `:${cVar.name}` : cVar.name;
        const insertText = `${fullName}="\${1:${cVar.defaultValue || ''}}"`;
        const item = new vscode.CompletionItem(fullName, vscode.CompletionItemKind.Field);
        item.insertText = new vscode.SnippetString(insertText);
        item.filterText = fullName;
        if (partialInfo) {
            item.range = partialInfo.range;
        }
        const type = isDjangoExpression ? 'Django expression' : 'text parameter';
        const icon = isDjangoExpression ? '🔗' : '🏷️';
        item.documentation = new vscode.MarkdownString(`**${fullName}** (${type})\n\nDefault: \`${cVar.defaultValue || 'undefined'}\`\n\n${icon} Cotton parameter`);
        item.sortText = `0_${fullName}`;
        item.detail = `${icon} Cotton ${type}`;
        item.preselect = true;
        return item;
    }
    getPartialParameterAtPosition(line, position, lineNumber) {
        let start = position;
        while (start > 0) {
            const char = line[start - 1];
            if (char === ' ' || char === '\t' || char === '\n')
                break;
            if (char === '=' || char === '"' || char === "'" || char === '>')
                return undefined;
            start--;
        }
        const alreadyTyped = line.substring(start, position);
        if (alreadyTyped.length > 0 && /^:?[a-zA-Z_][\w.-]*$/.test(alreadyTyped)) {
            return {
                alreadyTyped,
                range: new vscode.Range(new vscode.Position(lineNumber, start), new vscode.Position(lineNumber, position))
            };
        }
        return undefined;
    }
    parseExistingAttributes(document, position, componentName) {
        const existingAttributes = new Set();
        const documentText = document.getText();
        const offset = document.offsetAt(position);
        // Find the start of the current Cotton tag
        const textBeforeCursor = documentText.substring(0, offset);
        const tagStartPattern = new RegExp(`<c-${componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
        let tagStartMatch = null;
        let match;
        while ((match = tagStartPattern.exec(textBeforeCursor)) !== null) {
            tagStartMatch = match;
        }
        if (!tagStartMatch)
            return existingAttributes;
        const tagStartOffset = tagStartMatch.index;
        // Find the closing > of this tag
        const afterTagStart = documentText.substring(tagStartOffset);
        const closingBracketMatch = afterTagStart.match(/>/);
        if (!closingBracketMatch)
            return existingAttributes;
        const tagEndOffset = tagStartOffset + closingBracketMatch.index;
        // Extract the tag content (everything between <c-componentName and >)
        const tagContent = documentText.substring(tagStartOffset, tagEndOffset + 1);
        // Parse attributes from the tag content
        const attributeRegex = /\s+(:?)(\w+)(?:=["'][^"']*["'])?/g;
        while ((match = attributeRegex.exec(tagContent)) !== null) {
            const hasColon = match[1] === ':';
            const attrName = match[2];
            existingAttributes.add(hasColon ? `:${attrName}` : attrName);
        }
        return existingAttributes;
    }
    async parseCVars(filePath) {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const cVarsMatch = content.match(/<c-vars\s+([^>]+)>/);
            if (!cVarsMatch)
                return undefined;
            const cVars = [];
            const attributeRegex = /(:?)(\w+)(?:=["']([^"']*)["'])?/g;
            let match;
            while ((match = attributeRegex.exec(cVarsMatch[1])) !== null) {
                cVars.push({
                    name: match[2],
                    defaultValue: match[3] || '',
                    isDjangoExpression: match[1] === ':'
                });
            }
            return cVars;
        }
        catch {
            return undefined;
        }
    }
}
// Diagnostic provider
class CottonDiagnosticProvider {
    constructor(diagnosticCollection) {
        this.diagnosticCollection = diagnosticCollection;
    }
    activate(context) {
        const updateDiagnostics = (document) => this.updateDiagnostics(document);
        context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => updateDiagnostics(event.document)), vscode.workspace.onDidOpenTextDocument(updateDiagnostics), vscode.workspace.onDidSaveTextDocument(updateDiagnostics));
        vscode.workspace.textDocuments.forEach(updateDiagnostics);
    }
    async updateDiagnostics(document) {
        if (!['html', 'django-html'].includes(document.languageId))
            return;
        const diagnostics = [];
        const text = document.getText();
        const cottonTagRegex = /<c-([\w.-]+)(?:\s[^>]*)?(?:\/?>|>)/g;
        let match;
        while ((match = cottonTagRegex.exec(text)) !== null) {
            const componentName = match[1];
            if (COTTON_BUILTIN_DIRECTIVES.includes(componentName))
                continue;
            const componentExists = await findComponentFile(componentName);
            if (!componentExists) {
                const startPos = document.positionAt(match.index);
                const endPos = document.positionAt(match.index + `<c-${componentName}`.length);
                const diagnostic = new vscode.Diagnostic(new vscode.Range(startPos, endPos), `Cotton component '${componentName}' not found`, vscode.DiagnosticSeverity.Error);
                diagnostic.code = 'cotton-component-not-found';
                diagnostic.source = 'Cotton';
                diagnostics.push(diagnostic);
            }
        }
        this.diagnosticCollection.set(document.uri, diagnostics);
    }
}
function deactivate() { }
//# sourceMappingURL=extension.js.map