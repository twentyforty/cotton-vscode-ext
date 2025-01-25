"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
function activate(context) {
    const provider = new CottonDefinitionProvider();
    let disposable = vscode.languages.registerDefinitionProvider(['html', 'django-html'], provider);
    context.subscriptions.push(disposable);
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
        const componentStart = tagStart + (fullTag.startsWith('</') ? 2 : 1); // Skip <c- or </c-
        const componentEnd = componentStart + componentName.length + 2;
        // Create a range that only includes the component name
        const hoverRange = new vscode.Range(new vscode.Position(position.line, componentStart), new vscode.Position(position.line, componentEnd));
        const tagPath = componentName.replace(/\./g, '/');
        console.log('Extracted path:', tagPath);
        const pathVariations = [
            tagPath, // original
            tagPath.replace(/-/g, '_'), // hyphens to underscores
            tagPath.replace(/_/g, '-') // underscores to hyphens
        ];
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder)
            return undefined;
        const config = vscode.workspace.getConfiguration('cottonTemplateTags');
        const templatePaths = config.get('templatePaths', ['templates/cotton']);
        for (const templateBasePath of templatePaths) {
            for (const pathVariation of pathVariations) {
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
                    continue;
                }
            }
        }
        return undefined;
    }
}
function deactivate() { }
//# sourceMappingURL=extension.js.map