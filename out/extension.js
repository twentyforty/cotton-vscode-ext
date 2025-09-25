"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
function activate(context) {
    const definitionProvider = new CottonDefinitionProvider();
    const completionProvider = new CottonCompletionProvider();
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(['html', 'django-html'], definitionProvider), vscode.languages.registerCompletionItemProvider(['html', 'django-html'], completionProvider, '<' // Trigger character
    ));
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
function deactivate() { }
//# sourceMappingURL=extension.js.map