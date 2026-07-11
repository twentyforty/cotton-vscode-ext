import {
    CompletionItem,
    CompletionItemKind,
    InsertTextFormat,
    TextEdit,
    Range,
    Position
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CottonParser } from '../cottonParser';
import { ComponentIndex, CVarDefinition } from '../utils/componentIndex';

export class CompletionHandler {
    constructor(
        private parser: CottonParser,
        private componentIndex: ComponentIndex
    ) {}

    async handleCompletion(
        document: TextDocument,
        position: Position
    ): Promise<CompletionItem[]> {
        const content = document.getText();
        const offset = document.offsetAt(position);
        const htmlDoc = this.parser.parseDocument(content, document.uri);

        const slotNode = this.parser.findComponentAtOffset(htmlDoc, offset);
        if (slotNode?.fullTag === 'c-slot') {
            const slotContext = this.parser.getSlotNameContext(content, slotNode.node, offset);
            if (slotContext) {
                return this.getSlotNameCompletions(slotContext, document);
            }
        }

        const context = this.parser.getCursorContext(content, offset, htmlDoc);

        if (context.isTypingTagName) {
            return this.getTagCompletions(context.partialTagName || '', position, document, content, offset);
        }

        if (context.isInsideCottonTag && context.componentName) {
            // `component` and `slot` are built-in directives, not real component files, so they
            // don't have `<c-vars>` to drive attribute completion - offer their known attributes directly.
            if (context.componentName === 'component') {
                return this.getComponentDirectiveAttributeCompletions(context.existingAttributes, context.partialAttributeName, position);
            }
            if (context.componentName === 'slot') {
                return this.getSlotDirectiveAttributeCompletions(context.existingAttributes, context.partialAttributeName, position);
            }

            return this.getAttributeCompletions(
                context.componentName,
                context.existingAttributes,
                context.partialAttributeName,
                position
            );
        }

        return [];
    }

    private static readonly BUILTIN_DIRECTIVES: { name: string; documentation: string }[] = [
        { name: 'vars', documentation: 'Declare in-component variables and default prop values.\n\nUsage: `<c-vars title="default" :count="0" />` at the top of a component file.' },
        { name: 'slot', documentation: 'Provide HTML content for a named slot inside a component.\n\nUsage:\n```html\n<c-slot name="icon">\n    <svg>...</svg>\n</c-slot>\n```' },
        { name: 'component', documentation: 'Render a component dynamically by name.\n\nUsage: `<c-component is="button" />` or `<c-component :is="expr" />`.' }
    ];

    private async getTagCompletions(
        partial: string,
        position: Position,
        document: TextDocument,
        content: string,
        offset: number
    ): Promise<CompletionItem[]> {
        const components = await this.componentIndex.getAllComponents();
        const items: CompletionItem[] = [];

        const replaceRange = Range.create(
            Position.create(position.line, position.character - partial.length),
            position
        );

        const closingTagEdit = this.findClosingTagEdit(content, offset, partial, document);

        for (const component of components) {
            if (!partial || component.name.toLowerCase().startsWith(partial.toLowerCase())) {
                const doc = await this.componentIndex.getComponentDocumentation(component.filePath);
                
                const item: CompletionItem = {
                    label: component.name,
                    kind: CompletionItemKind.Class,
                    detail: 'Cotton component',
                    documentation: doc || undefined,
                    sortText: `0_${component.name}`,
                    filterText: component.name,
                    textEdit: TextEdit.replace(replaceRange, component.name),
                    insertTextFormat: InsertTextFormat.PlainText
                };

                if (closingTagEdit) {
                    item.additionalTextEdits = [
                        TextEdit.replace(closingTagEdit.range, component.name)
                    ];
                }

                items.push(item);
            }
        }

        for (const directive of CompletionHandler.BUILTIN_DIRECTIVES) {
            if (!partial || directive.name.toLowerCase().startsWith(partial.toLowerCase())) {
                const item: CompletionItem = {
                    label: directive.name,
                    kind: CompletionItemKind.Keyword,
                    detail: 'Cotton directive',
                    documentation: { kind: 'markdown', value: directive.documentation },
                    sortText: `1_${directive.name}`,
                    filterText: directive.name,
                    textEdit: TextEdit.replace(replaceRange, directive.name),
                    insertTextFormat: InsertTextFormat.PlainText
                };

                if (closingTagEdit) {
                    item.additionalTextEdits = [
                        TextEdit.replace(closingTagEdit.range, directive.name)
                    ];
                }

                items.push(item);
            }
        }

        return items;
    }

    private findClosingTagEdit(
        content: string,
        offset: number,
        partial: string,
        document: TextDocument
    ): { range: Range } | null {
        const textAfter = content.substring(offset);
        const closingTagRegex = new RegExp(`</c-(${this.escapeRegex(partial)}[\\w.-]*)>`);
        const closingMatch = textAfter.match(closingTagRegex);
        
        if (closingMatch) {
            const closingTagName = closingMatch[1];
            
            if (closingTagName === partial || closingTagName.startsWith(partial)) {
                const closingTagNameStart = offset + closingMatch.index! + 4; // +4 for '</c-'
                const closingTagNameEnd = closingTagNameStart + closingTagName.length;
                
                return {
                    range: Range.create(
                        document.positionAt(closingTagNameStart),
                        document.positionAt(closingTagNameEnd)
                    )
                };
            }
        }

        return null;
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private async getAttributeCompletions(
        componentName: string,
        existingAttributes: Set<string>,
        partialAttr: string | null,
        position: Position
    ): Promise<CompletionItem[]> {
        const component = await this.componentIndex.findComponent(componentName);
        if (!component || component.cVars.length === 0) {
            return [];
        }

        const items: CompletionItem[] = [];
        
        let replaceRange: Range | undefined;
        if (partialAttr) {
            replaceRange = Range.create(
                Position.create(position.line, position.character - partialAttr.length),
                position
            );
        }

        for (const cVar of component.cVars) {
            if (!existingAttributes.has(cVar.name)) {
                if (!partialAttr || cVar.name.toLowerCase().startsWith(partialAttr.toLowerCase())) {
                    items.push(this.createAttributeItem(cVar, false, replaceRange));

                    // A c-var declared with no default (e.g. `<c-vars errors />`) is commonly
                    // used as a boolean flag - Cotton lets you pass it with no value at all,
                    // which becomes `True`. Offer that as a distinct, valueless completion.
                    if (!cVar.defaultValue && !cVar.isDjangoExpression) {
                        items.push(this.createBooleanAttributeItem(cVar, replaceRange));
                    }
                }
            }

            const expressionName = `:${cVar.name}`;
            if (!existingAttributes.has(expressionName)) {
                if (!partialAttr || expressionName.toLowerCase().startsWith(partialAttr.toLowerCase())) {
                    items.push(this.createAttributeItem(cVar, true, replaceRange));
                }
            }
        }

        return items;
    }

    private createAttributeItem(
        cVar: CVarDefinition,
        isDjangoExpression: boolean,
        replaceRange?: Range
    ): CompletionItem {
        const fullName = isDjangoExpression ? `:${cVar.name}` : cVar.name;
        const insertText = `${fullName}="\${1:${cVar.defaultValue || ''}}"`;
        const type = isDjangoExpression ? 'Django expression' : 'text parameter';

        const item: CompletionItem = {
            label: fullName,
            kind: CompletionItemKind.Field,
            insertTextFormat: InsertTextFormat.Snippet,
            filterText: fullName,
            detail: `Cotton ${type}`,
            documentation: {
                kind: 'markdown',
                value: `**${fullName}** (${type})\n\nDefault: \`${cVar.defaultValue || 'undefined'}\``
            },
            sortText: `0_${fullName}`
        };

        if (replaceRange) {
            item.textEdit = TextEdit.replace(replaceRange, insertText);
        } else {
            item.insertText = insertText;
        }

        return item;
    }

    private getComponentDirectiveAttributeCompletions(
        existingAttributes: Set<string>,
        partialAttr: string | null,
        position: Position
    ): CompletionItem[] {
        const replaceRange = this.getReplaceRange(partialAttr, position);
        const items: CompletionItem[] = [];

        if (this.matchesPartial('is', existingAttributes, partialAttr)) {
            items.push(this.createDirectiveAttributeItem(
                'is',
                'Name of the component to render dynamically, e.g. `is="button"` or a subfolder path `is="ui.button"`.',
                replaceRange
            ));
        }

        if (this.matchesPartial(':is', existingAttributes, partialAttr)) {
            items.push(this.createDirectiveAttributeItem(
                ':is',
                'Render a component whose name is a Django expression, e.g. `:is="field.type"`.',
                replaceRange
            ));
        }

        return items;
    }

    private getSlotDirectiveAttributeCompletions(
        existingAttributes: Set<string>,
        partialAttr: string | null,
        position: Position
    ): CompletionItem[] {
        if (!this.matchesPartial('name', existingAttributes, partialAttr)) {
            return [];
        }

        const replaceRange = this.getReplaceRange(partialAttr, position);
        return [this.createDirectiveAttributeItem(
            'name',
            'Name of the slot this content fills, matching a `{{ name }}` reference in the target component.',
            replaceRange
        )];
    }

    private matchesPartial(attrName: string, existingAttributes: Set<string>, partialAttr: string | null): boolean {
        if (existingAttributes.has(attrName)) return false;
        return !partialAttr || attrName.toLowerCase().startsWith(partialAttr.toLowerCase());
    }

    private getReplaceRange(partialAttr: string | null, position: Position): Range | undefined {
        if (!partialAttr) return undefined;
        return Range.create(
            Position.create(position.line, position.character - partialAttr.length),
            position
        );
    }

    private createDirectiveAttributeItem(fullName: string, documentation: string, replaceRange?: Range): CompletionItem {
        const insertText = `${fullName}="\${1}"`;

        const item: CompletionItem = {
            label: fullName,
            kind: CompletionItemKind.Field,
            insertTextFormat: InsertTextFormat.Snippet,
            filterText: fullName,
            detail: 'Cotton directive attribute',
            documentation: { kind: 'markdown', value: documentation },
            sortText: `0_${fullName}`
        };

        if (replaceRange) {
            item.textEdit = TextEdit.replace(replaceRange, insertText);
        } else {
            item.insertText = insertText;
        }

        return item;
    }

    private async getSlotNameCompletions(
        slotContext: { componentName: string; valueStart: number; valueEnd: number },
        document: TextDocument
    ): Promise<CompletionItem[]> {
        const component = await this.componentIndex.findComponent(slotContext.componentName);
        if (!component) return [];

        const excludeNames = new Set(component.cVars.map(v => v.name));
        const slotNames = await this.componentIndex.getSlotCandidates(component.filePath, excludeNames);

        const replaceRange = Range.create(
            document.positionAt(slotContext.valueStart),
            document.positionAt(slotContext.valueEnd)
        );

        return slotNames.map(name => ({
            label: name,
            kind: CompletionItemKind.EnumMember,
            detail: 'Cotton named slot',
            documentation: `Fills \`{{ ${name} }}\` in \`<c-${slotContext.componentName}>\``,
            textEdit: TextEdit.replace(replaceRange, name),
            sortText: `0_${name}`
        }));
    }

    private createBooleanAttributeItem(cVar: CVarDefinition, replaceRange?: Range): CompletionItem {
        const item: CompletionItem = {
            label: cVar.name,
            kind: CompletionItemKind.Value,
            insertTextFormat: InsertTextFormat.PlainText,
            filterText: cVar.name,
            detail: 'Cotton boolean flag',
            documentation: {
                kind: 'markdown',
                value: `**${cVar.name}** (boolean flag)\n\nPass with no value to provide \`True\` to the component.`
            },
            sortText: `1_${cVar.name}`
        };

        if (replaceRange) {
            item.textEdit = TextEdit.replace(replaceRange, cVar.name);
        } else {
            item.insertText = cVar.name;
        }

        return item;
    }
}
