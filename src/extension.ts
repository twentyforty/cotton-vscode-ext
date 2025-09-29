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

        // Enhance completion items with smart closing tag handling
        const enhancedItems = await Promise.all(completionItems.map(async item => 
            this.enhanceCompletionItem(item, document, position, partialName)
        ));

        // Filter items based on what's been typed
        if (partialName) {
            const filteredItems = enhancedItems.filter(item => 
                item.label.toString().toLowerCase().startsWith(partialName.toLowerCase())
            );
            return filteredItems;
        }

        return enhancedItems;
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

        // Default insertion text (will be enhanced later)
        completionItem.insertText = new vscode.SnippetString(`${componentName}>\${0}</c-${componentName}>`);
        
        // Add documentation from the template file
        this.addDocumentation(completionItem, filePath);

        return completionItem;
    }

    private async enhanceCompletionItem(
        item: vscode.CompletionItem, 
        document: vscode.TextDocument, 
        position: vscode.Position, 
        partialName: string
    ): Promise<vscode.CompletionItem> {
        try {
            const componentName = item.label.toString();
            const documentText = document.getText();
            const currentOffset = document.offsetAt(position);
            
            // Find the current opening tag that we're replacing
            const openingTagInfo = this.findCurrentOpeningTag(documentText, currentOffset);
            
            if (openingTagInfo) {
                const { start, end, currentComponentName, isSelfClosing } = openingTagInfo;
                
                // Calculate the range for just the component name part (after "<c-")
                const componentNameStart = start + 3; // Skip "<c-"
                const replaceRange = new vscode.Range(
                    document.positionAt(componentNameStart),
                    document.positionAt(end)
                );
                
                if (isSelfClosing) {
                    // Self-closing tag - just replace the component name, don't add closing tag
                    item.insertText = new vscode.SnippetString(`${componentName}\${0}`);
                    item.range = replaceRange;
                } else {
                    // Find the matching closing tag
                    const closingTagInfo = this.findMatchingClosingTag(documentText, end, currentComponentName);
                    
                    if (closingTagInfo) {
                        // Both opening and closing tags exist - replace both component names
                        const additionalTextEdits: vscode.TextEdit[] = [
                            vscode.TextEdit.replace(
                                new vscode.Range(
                                    document.positionAt(closingTagInfo.start),
                                    document.positionAt(closingTagInfo.end)
                                ),
                                `</c-${componentName}>`
                            )
                        ];
                        
                        item.insertText = new vscode.SnippetString(`${componentName}\${0}`);
                        item.range = replaceRange;
                        item.additionalTextEdits = additionalTextEdits;
                    } else {
                        // Only opening tag exists - replace component name and add closing tag after the >
                        const restOfDocument = documentText.substring(end);
                        const closingBracketIndex = restOfDocument.indexOf('>');
                        
                        if (closingBracketIndex !== -1) {
                            const closingBracketPosition = end + closingBracketIndex + 1;
                            const additionalTextEdits: vscode.TextEdit[] = [
                                vscode.TextEdit.insert(
                                    document.positionAt(closingBracketPosition),
                                    `</c-${componentName}>`
                                )
                            ];
                            
                            item.insertText = new vscode.SnippetString(`${componentName}\${0}`);
                            item.range = replaceRange;
                            item.additionalTextEdits = additionalTextEdits;
                        } else {
                            // No closing bracket found, add both > and closing tag
                            item.insertText = new vscode.SnippetString(`${componentName}>\${0}</c-${componentName}>`);
                            item.range = replaceRange;
                        }
                    }
                }
            } else {
                // Fallback: no existing tag found, insert new tag pair
                item.insertText = new vscode.SnippetString(`${componentName}>\${0}</c-${componentName}>`);
            }
            
            return item;
        } catch (error) {
            console.error('Cotton: Error enhancing completion item:', error);
            // Return the original item if enhancement fails
            return item;
        }
    }

    private findCurrentOpeningTag(documentText: string, currentOffset: number): { start: number; end: number; currentComponentName: string; isSelfClosing: boolean } | undefined {
        // Look backwards and forwards from cursor to find the tag we're currently editing
        const textBeforeCursor = documentText.substring(0, currentOffset);
        
        // Find the most recent < before cursor
        const lastOpenBracket = textBeforeCursor.lastIndexOf('<');
        if (lastOpenBracket === -1) {
            return undefined;
        }
        
        // Check if this is a Cotton tag
        const tagStart = textBeforeCursor.substring(lastOpenBracket);
        const cottonTagMatch = tagStart.match(/^<c-([\w.-]*)/);
        if (!cottonTagMatch) {
            return undefined;
        }
        
        // Now find the end of the tag name (either at space, > or current position)
        const fromTagStart = documentText.substring(lastOpenBracket);
        
        // Match the full component name, handling the case where cursor might be in the middle
        const fullTagMatch = fromTagStart.match(/^<c-([\w.-]*?)(\s|>|$)/);
        let tagEnd: number;
        let currentComponentName: string;
        let isSelfClosing = false;
        
        if (fullTagMatch && fullTagMatch[2] !== '') {
            // Complete tag with space or > after component name
            const componentNameEnd = lastOpenBracket + 3 + fullTagMatch[1].length; // 3 for "<c-"
            tagEnd = componentNameEnd;
            currentComponentName = fullTagMatch[1];
            
            // Check if this is a self-closing tag by looking for /> 
            const restOfTag = documentText.substring(componentNameEnd);
            const tagCloseMatch = restOfTag.match(/^[^>]*\/>/);
            if (tagCloseMatch) {
                isSelfClosing = true;
            }
        } else {
            // We're in the middle of typing the component name or at the end
            // Find where the component name ends (at space, > or end of text)
            const componentNameStart = lastOpenBracket + 3; // Skip "<c-"
            let componentNameEnd = componentNameStart;
            
            // Scan forward to find the end of the component name
            while (componentNameEnd < documentText.length) {
                const char = documentText[componentNameEnd];
                if (char === ' ' || char === '>' || char === '\t' || char === '\n') {
                    break;
                }
                componentNameEnd++;
            }
            
            tagEnd = componentNameEnd;
            currentComponentName = documentText.substring(componentNameStart, componentNameEnd);
            
            // Check if this will be a self-closing tag by looking ahead
            const restOfTag = documentText.substring(componentNameEnd);
            const tagCloseMatch = restOfTag.match(/^[^>]*\/>/);
            if (tagCloseMatch) {
                isSelfClosing = true;
            }
        }
        
        const result = { 
            start: lastOpenBracket, 
            end: tagEnd, 
            currentComponentName,
            isSelfClosing
        };
        
        return result;
    }

    private findMatchingClosingTag(documentText: string, currentOffset: number, currentComponentName: string): { start: number; end: number } | undefined {
        if (!currentComponentName) return undefined;
        
        // Look for the closing tag pattern after the current position
        const afterCursor = documentText.substring(currentOffset);
        const closingTagPattern = new RegExp(`</c-${currentComponentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'i');
        const match = closingTagPattern.exec(afterCursor);
        
        if (match) {
            const start = currentOffset + match.index;
            const end = start + match[0].length;
            return { start, end };
        }
        
        return undefined;
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
        // Find if we're inside a Cotton component tag (potentially multi-line)
        const tagContext = this.findCottonTagContext(document, position);
        if (!tagContext) return undefined;

        const { componentName, isInsideTag } = tagContext;
        
        // Only provide completions if we're actually inside the tag (not after closing >)
        if (!isInsideTag) return undefined;

        // Detect what the user has already typed for the current parameter
        const line = document.lineAt(position.line).text;
        const char = position.character;
        const partialParameterInfo = this.getPartialParameterAtPosition(line, char, position.line);
        
        // Get the component file path and parse c-vars
        const componentFilePath = await CottonUtils.findComponentFile(componentName);
        if (!componentFilePath) return undefined;

        const cVars = await this.parseCVars(componentFilePath);
        if (!cVars || cVars.length === 0) return undefined;

        // Parse existing attributes to avoid duplicates (multi-line aware)
        const existingAttributes = this.parseExistingAttributesMultiLine(document, position, componentName);

        // Create completion items for each c-var
        const completionItems: vscode.CompletionItem[] = [];
        
        for (const cVar of cVars) {
            // Regular parameter
            if (!existingAttributes.has(cVar.name)) {
                const regularItem = this.createAttributeCompletionItem(cVar, false, partialParameterInfo);
                if (regularItem) {
                    completionItems.push(regularItem);
                }
            }

            // Django expression parameter
            if (!existingAttributes.has(`:${cVar.name}`)) {
                const expressionItem = this.createAttributeCompletionItem(cVar, true, partialParameterInfo);
                if (expressionItem) {
                    completionItems.push(expressionItem);
                }
            }
        }

        return completionItems;
    }

    private createAttributeCompletionItem(
        cVar: CVarDefinition, 
        isDjangoExpression: boolean, 
        partialParameterInfo: { alreadyTyped: string; range: vscode.Range } | undefined
    ): vscode.CompletionItem {
        const prefix = isDjangoExpression ? ':' : '';
        const fullName = `${prefix}${cVar.name}`;
        
        // Determine what to insert based on what's already typed
        let insertText: string;
        let filterText: string = fullName;
        
        if (partialParameterInfo) {
            const alreadyTyped = partialParameterInfo.alreadyTyped;
            
            // Check if what's already typed matches the beginning of this parameter
            if (fullName.toLowerCase().startsWith(alreadyTyped.toLowerCase())) {
                // Only insert the remaining part
                const remaining = fullName.substring(alreadyTyped.length);
                insertText = `${remaining}="\${1:${cVar.defaultValue || ''}}"`;
            } else {
                // Special case: if user typed ":" and this is a Django expression parameter
                if (alreadyTyped === ':' && isDjangoExpression) {
                    // User typed just ":", insert the parameter name without the ":"
                    insertText = `${cVar.name}="\${1:${cVar.defaultValue || ''}}"`;
                } else {
                    // Doesn't match, skip this item
                    return null as any; // Will be filtered out
                }
            }
        } else {
            // Nothing typed yet, insert full parameter
            insertText = `${fullName}="\${1:${cVar.defaultValue || ''}}"`;
        }
        
        const item = new vscode.CompletionItem(fullName, vscode.CompletionItemKind.Field);
        item.insertText = new vscode.SnippetString(insertText);
        item.filterText = filterText;
        
        // Set the range to replace if we have partial typing
        if (partialParameterInfo) {
            item.range = partialParameterInfo.range;
        }
        
        const type = isDjangoExpression ? 'Django expression parameter' : 'text parameter';
        const icon = isDjangoExpression ? '🔗' : '🏷️';
        
        item.documentation = new vscode.MarkdownString(
            `**${fullName}** (${type})\n\nDefault: \`${cVar.defaultValue || 'undefined'}\`\n\n${icon} Cotton component parameter`
        );
        item.sortText = `0_${fullName}`;
        item.detail = `${icon} Cotton ${isDjangoExpression ? 'expression' : 'parameter'}`;
        item.preselect = true;

        return item;
    }

    private getPartialParameterAtPosition(line: string, position: number, lineNumber: number): { alreadyTyped: string; range: vscode.Range } | undefined {
        // Look backwards from cursor to find the start of the current parameter being typed
        let start = position;
        
        // Move backwards while we're in valid parameter name characters
        while (start > 0) {
            const char = line[start - 1];
            if (char === ' ' || char === '\t' || char === '\n') {
                break; // Found whitespace, this is the start
            }
            if (char === '=' || char === '"' || char === "'" || char === '>') {
                return undefined; // We're not typing a parameter name
            }
            start--;
        }
        
        // Extract what's been typed so far
        const alreadyTyped = line.substring(start, position).trim();
        
        // Only consider it partial typing if it looks like the start of a parameter
        if (alreadyTyped.length > 0 && /^:?[a-zA-Z_][\w.-]*$/.test(alreadyTyped)) {
            return {
                alreadyTyped,
                range: new vscode.Range(
                    new vscode.Position(lineNumber, start),
                    new vscode.Position(lineNumber, position)
                )
            };
        }
        
        return undefined;
    }

    private findCottonTagContext(document: vscode.TextDocument, position: vscode.Position): { componentName: string; isInsideTag: boolean } | undefined {
        const documentText = document.getText();
        const offset = document.offsetAt(position);
        
        // Look backwards from cursor to find the most recent Cotton tag opening
        const textBeforeCursor = documentText.substring(0, offset);
        
        // Find all Cotton tag openings before the cursor
        const tagOpeningRegex = /<c-([\w.-]+)/g;
        let lastTagMatch: RegExpExecArray | null = null;
        let match;
        
        while ((match = tagOpeningRegex.exec(textBeforeCursor)) !== null) {
            lastTagMatch = match;
        }
        
        if (!lastTagMatch) return undefined;
        
        const componentName = lastTagMatch[1];
        const tagStartOffset = lastTagMatch.index;
        
        // Find the closing > of this tag
        const afterTagStart = documentText.substring(tagStartOffset);
        const closingBracketMatch = afterTagStart.match(/>/);
        
        if (!closingBracketMatch) {
            // No closing > found, we're definitely inside the tag
            return { componentName, isInsideTag: true };
        }
        
        const closingBracketOffset = tagStartOffset + closingBracketMatch.index!;
        
        // Check if cursor is before the closing >
        if (offset <= closingBracketOffset) {
            return { componentName, isInsideTag: true };
        }
        
        // Cursor is after the closing >, check if there's a matching closing tag
        // If there is, we might be in the content area, not inside the tag
        const afterClosingBracket = documentText.substring(closingBracketOffset + 1);
        const closingTagPattern = new RegExp(`</c-${componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'i');
        const closingTagMatch = closingTagPattern.exec(afterClosingBracket);
        
        if (closingTagMatch) {
            const closingTagOffset = closingBracketOffset + 1 + closingTagMatch.index;
            // If cursor is before the closing tag, we're in content area, not inside tag for attributes
            if (offset < closingTagOffset) {
                return undefined; // In content area
            }
        }
        
        return undefined; // Not inside a tag
    }

    private parseExistingAttributesMultiLine(document: vscode.TextDocument, position: vscode.Position, componentName: string): Set<string> {
        const documentText = document.getText();
        const offset = document.offsetAt(position);
        
        // Find the start of the current Cotton tag
        const textBeforeCursor = documentText.substring(0, offset);
        const tagStartPattern = new RegExp(`<c-${componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
        let tagStartMatch: RegExpExecArray | null = null;
        let match;
        
        while ((match = tagStartPattern.exec(textBeforeCursor)) !== null) {
            tagStartMatch = match;
        }
        
        if (!tagStartMatch) return new Set<string>();
        
        const tagStartOffset = tagStartMatch.index;
        
        // Find the closing > of this tag
        const afterTagStart = documentText.substring(tagStartOffset);
        const closingBracketMatch = afterTagStart.match(/>/);
        
        if (!closingBracketMatch) return new Set<string>();
        
        const tagEndOffset = tagStartOffset + closingBracketMatch.index!;
        
        // Extract the tag content (everything between <c-componentName and >)
        const tagContent = documentText.substring(tagStartOffset, tagEndOffset + 1);
        
        // Parse attributes from the tag content
        const existingAttributes = new Set<string>();
        const attributeRegex = /\s+(:?)(\w+)(?:=["'][^"']*["'])?/g;
        
        while ((match = attributeRegex.exec(tagContent)) !== null) {
            const hasColon = match[1] === ':';
            const attrName = match[2];
            
            existingAttributes.add(hasColon ? `:${attrName}` : attrName);
        }
        
        return existingAttributes;
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