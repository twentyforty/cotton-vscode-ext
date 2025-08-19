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

        console.log(`Finding tag definition at line ${position.line}, char ${char}`);
        // Find the start of the tag before the cursor
        let tagStart = line.lastIndexOf('<', char);
        if (tagStart === -1) return undefined;

        // For multiline tags, we need to find the tag name from just the opening part
        // Look for the tag name right after the '<' 
        const lineFromTagStart = line.substring(tagStart);

        // Check if it's a cotton tag by looking at the beginning
        if (!lineFromTagStart.startsWith('<c-') && !lineFromTagStart.startsWith('</c-')) {
            return undefined;
        }

        // Extract just the component name (look for first space, newline, or > after the tag name)
        const componentMatch = lineFromTagStart.match(/^<\/?c-([\w.-]+)/);
        if (!componentMatch) return undefined;

        const componentName = componentMatch[1]; // This is just the component name without c- prefix

        console.log(`Found component: ${componentName}`);

        // Calculate the range for just the component name
        const isClosingTag = lineFromTagStart.startsWith('</');
        const componentStart = tagStart + (isClosingTag ? 4 : 3); // Skip <c- or </c-
        const componentEnd = componentStart + componentName.length;
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
                // First try the direct .html file
                const templatePath = path.join(
                    workspaceFolder.uri.fsPath,
                    templateBasePath,
                    pathVariation + '.html'
                );

                console.log('Trying direct file:', templatePath);
                try {
                    await fs.promises.access(templatePath);
                    console.log('Found direct file:', templatePath);
                    return [
                        {
                            originSelectionRange: hoverRange,
                            targetUri: vscode.Uri.file(templatePath),
                            targetRange: new vscode.Range(0, 0, 0, 0),
                            targetSelectionRange: new vscode.Range(0, 0, 0, 0)
                        }
                    ];
                } catch {
                    // If direct .html file doesn't exist, try index.html in subdirectory
                    const indexTemplatePath = path.join(
                        workspaceFolder.uri.fsPath,
                        templateBasePath,
                        pathVariation,
                        'index.html'
                    );

                    console.log('Trying index file:', indexTemplatePath);
                    try {
                        await fs.promises.access(indexTemplatePath);
                        console.log('Found index file:', indexTemplatePath);
                        return [
                            {
                                originSelectionRange: hoverRange,
                                targetUri: vscode.Uri.file(indexTemplatePath),
                                targetRange: new vscode.Range(0, 0, 0, 0),
                                targetSelectionRange: new vscode.Range(0, 0, 0, 0)
                            }
                        ];
                    } catch {
                        console.log('File not found:', indexTemplatePath);
                        continue;
                    }
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
                    let componentName: string;

                    if (entry.name === 'index.html') {
                        // For index.html files, use the parent directory name as the component name
                        componentName = relativePath
                            .replace(/[\\/]/g, '.') // Replace slashes with dots
                            .replace(/_/g, '-'); // Replace underscores with hyphens
                    } else {
                        // For regular .html files, use the filename without extension
                        componentName = currentRelativePath
                            .slice(0, -5) // Remove .html extension
                            .replace(/[\\/]/g, '.') // Replace slashes with dots
                            .replace(/_/g, '-'); // Replace underscores with hyphens
                    }

                    // Skip if componentName is empty (root index.html)
                    if (!componentName) {
                        console.log(`Skipping empty componentName for: ${currentRelativePath}`);
                        continue;
                    }

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

export function deactivate() { }


