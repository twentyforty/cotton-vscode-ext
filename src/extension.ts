import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';



export function activate(context: vscode.ExtensionContext) {
    const definitionProvider = new CottonDefinitionProvider();
    const completionProvider = new CottonCompletionProvider();

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            ['html', 'django-html'],
            definitionProvider
        ),
        vscode.languages.registerCompletionItemProvider(
            ['html', 'django-html'],
            completionProvider,
            '<' // Trigger character
        )
    );
}

class CottonDefinitionProvider implements vscode.DefinitionProvider {
    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.DefinitionLink[] | undefined> {
        const line = document.lineAt(position.line).text;
        const char = position.character;

        // Find the start of the tag before the cursor
        let tagStart = line.lastIndexOf('<', char);
        if (tagStart === -1) return undefined;

        // Find the end of the tag
        let tagEnd = line.indexOf('>', tagStart);
        if (tagEnd === -1) return undefined;

        // Get the full tag text
        const fullTag = line.substring(tagStart, tagEnd + 1);
        
        // Check if it's a cotton tag
        if (!fullTag.startsWith('<c-') && !fullTag.startsWith('</c-')) {
            return undefined;
        }

        // Extract just the component name (without < or attributes)
        const componentMatch = fullTag.match(/^<\/?c-([\w.-]+)/);
        if (!componentMatch) return undefined;

        const componentName = componentMatch[1]; // This is just the component name without c- prefix
        
        // Calculate the range for just the component name
        const componentStart = tagStart + (fullTag.startsWith('</') ? 2 : 1); // Skip <c- or </c-
        const componentEnd = componentStart + componentName.length + 2;
        // Create a range that only includes the component name
        const hoverRange = new vscode.Range(
            new vscode.Position(position.line, componentStart),
            new vscode.Position(position.line, componentEnd)
        );

        const tagPath = componentName.replace(/\./g, '/');
        console.log('Extracted path:', tagPath);

        const pathVariations = [
            tagPath,                    // original
            tagPath.replace(/-/g, '_'), // hyphens to underscores
            tagPath.replace(/_/g, '-')  // underscores to hyphens
        ];
        
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return undefined;

        const config = vscode.workspace.getConfiguration('djangoCotton');
        const templatePaths = config.get<string[]>('templatePaths', ['templates/cotton']);

        for (const templateBasePath of templatePaths) {
            for (const pathVariation of pathVariations) {
                const templatePath = path.join(
                    workspaceFolder.uri.fsPath,
                    templateBasePath,
                    pathVariation + '.html'
                );

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
                } catch {
                    continue;
                }
            }
        }

        return undefined;
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

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return undefined;

        const config = vscode.workspace.getConfiguration('djangoCotton');
        const templatePaths = config.get<string[]>('templatePaths', ['templates/cotton']);

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
                    // Recursively scan subdirectories
                    await this.collectTemplateFiles(basePath, currentRelativePath, items);
                } else if (entry.isFile() && entry.name.endsWith('.html')) {
                    // Create completion item for HTML files
                    const componentName = currentRelativePath
                        .slice(0, -5) // Remove .html extension
                        .replace(/[\\/]/g, '.') // Replace slashes with dots
                        .replace(/_/g, '-'); // Replace underscores with hyphens

                    const completionItem = new vscode.CompletionItem(
                        componentName,
                        vscode.CompletionItemKind.Snippet
                    );

                    // Add the full tag as the insertion text
                    completionItem.insertText = new vscode.SnippetString(`${componentName}>\${0}</c-${componentName}>`);
                    
                    // Add documentation from the template file
                    try {
                        const templateContent = await fs.promises.readFile(
                            path.join(basePath, currentRelativePath),
                            'utf-8'
                        );
                        const firstLine = templateContent.split('\n')[0].trim();
                        if (firstLine.startsWith('<!--') && firstLine.endsWith('-->')) {
                            completionItem.documentation = new vscode.MarkdownString(firstLine.slice(4, -3).trim());
                        }
                    } catch (error) {
                        console.error(`Error reading template file: ${currentRelativePath}`, error);
                    }

                    items.push(completionItem);
                }
            }
        } catch (error) {
            console.error(`Error scanning directory ${basePath}/${relativePath}:`, error);
        }
    }
}

export function deactivate() {}


