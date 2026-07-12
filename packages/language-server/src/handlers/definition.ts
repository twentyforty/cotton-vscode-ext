import {
    LocationLink,
    Position,
    Range
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { CottonParser } from '../cottonParser';
import { ComponentIndex } from '../utils/componentIndex';

export class DefinitionHandler {
    constructor(
        private parser: CottonParser,
        private componentIndex: ComponentIndex
    ) {}

    async handleDefinition(
        document: TextDocument,
        position: Position
    ): Promise<LocationLink[] | null> {
        const content = document.getText();
        const offset = document.offsetAt(position);
        const htmlDoc = this.parser.parseDocument(content, document.uri);

        const component = this.parser.findComponentAtOffset(htmlDoc, offset);
        
        if (component) {
            // <c-component is="literal-name" /> - resolve a *static* `is` value to a real
            // component. If `is` is a Django expression (`:is="..."`) or embeds template
            // syntax ({{ }} / {% %}), it can't be resolved statically, so we leave it alone.
            if (component.name === 'component') {
                const isAttr = this.parser.getAttributeValue(content, component.node, 'is');

                // Cmd/Ctrl+click the `is` value itself -> jump to that component's file.
                if (
                    isAttr &&
                    !isAttr.hasColon &&
                    !/[{}%]/.test(isAttr.value) &&
                    offset >= isAttr.start && offset <= isAttr.end
                ) {
                    const originRange = Range.create(
                        document.positionAt(isAttr.start),
                        document.positionAt(isAttr.end)
                    );
                    return this.getComponentLocationLink(isAttr.value, originRange);
                }

                // Cmd/Ctrl+click any other attribute (a prop passed through to whatever
                // component `is` resolves to) -> treat it exactly like a prop on a normal
                // component tag. Only possible when `is` is a static, resolvable name.
                if (isAttr && !isAttr.hasColon && !/[{}%]/.test(isAttr.value)) {
                    const attributeMatch = this.parser.findAttributeNameAtOffset(content, component.node, offset);
                    if (attributeMatch && attributeMatch.name !== 'is') {
                        const originRange = Range.create(
                            document.positionAt(attributeMatch.start),
                            document.positionAt(attributeMatch.end)
                        );
                        return this.getPropLocationLink(isAttr.value, attributeMatch.name, originRange);
                    }
                }

                return null;
            }

            // <c-slot name="icon"> - jump to where the enclosing component consumes this slot
            // (e.g. {{ icon }}), its <c-vars> declaration if it has one, or the top of the file.
            if (component.name === 'slot') {
                const slotContext = this.parser.getSlotNameContext(content, component.node, offset);
                if (slotContext && slotContext.slotName) {
                    const originRange = Range.create(
                        document.positionAt(slotContext.valueStart),
                        document.positionAt(slotContext.valueEnd)
                    );
                    return this.getPropLocationLink(slotContext.componentName, slotContext.slotName, originRange);
                }
                return null;
            }

            if (this.componentIndex.isBuiltinDirective(component.name)) {
                return null;
            }

            // Check opening tag name
            const tagNameRange = this.parser.getTagNameRange(component.node);
            if (tagNameRange && offset >= tagNameRange.start && offset <= tagNameRange.end) {
                const originRange = Range.create(
                    document.positionAt(tagNameRange.start),
                    document.positionAt(tagNameRange.end)
                );
                return this.getComponentLocationLink(component.name, originRange);
            }

            // Check an attribute name within the opening tag (a "prop" being passed to the component)
            const attributeMatch = this.parser.findAttributeNameAtOffset(content, component.node, offset);
            if (attributeMatch) {
                const originRange = Range.create(
                    document.positionAt(attributeMatch.start),
                    document.positionAt(attributeMatch.end)
                );
                return this.getPropLocationLink(component.name, attributeMatch.name, originRange);
            }

            // Check closing tag
            if (component.node.endTagStart !== undefined) {
                const closingStart = component.node.endTagStart + 2; // Skip '</'
                const closingEnd = closingStart + component.fullTag.length;
                if (offset >= closingStart && offset <= closingEnd) {
                    const originRange = Range.create(
                        document.positionAt(closingStart),
                        document.positionAt(closingEnd)
                    );
                    return this.getComponentLocationLink(component.name, originRange);
                }
            }
        }

        // Fallback: regex search for closing tags
        const closingTagInfo = this.findClosingTagAtOffset(content, offset);
        if (closingTagInfo && !this.componentIndex.isBuiltinDirective(closingTagInfo.name)) {
            const originRange = Range.create(
                document.positionAt(closingTagInfo.start),
                document.positionAt(closingTagInfo.end)
            );
            return this.getComponentLocationLink(closingTagInfo.name, originRange);
        }

        return null;
    }

    private async getComponentLocationLink(
        componentName: string,
        originSelectionRange: Range
    ): Promise<LocationLink[] | null> {
        const componentInfo = await this.componentIndex.findComponent(componentName);
        if (!componentInfo) {
            return null;
        }

        const targetRange = Range.create(Position.create(0, 0), Position.create(0, 0));

        return [{
            originSelectionRange,
            targetUri: URI.file(componentInfo.filePath).toString(),
            targetRange,
            targetSelectionRange: targetRange
        }];
    }

    /**
     * Resolve a prop (or slot name) clicked at a component usage site to a location inside the
     * component's file: its <c-vars> declaration, or its first usage in the file. If it's not
     * tracked by the component at all (neither declared nor referenced), there's nowhere
     * meaningful to navigate to, so go-to-definition should not activate - return null rather
     * than falling back to the top of the file.
     */
    private async getPropLocationLink(
        componentName: string,
        propName: string,
        originSelectionRange: Range
    ): Promise<LocationLink[] | null> {
        const componentInfo = await this.componentIndex.findComponent(componentName);
        if (!componentInfo) {
            return null;
        }

        const content = await this.componentIndex.getComponentFileContent(componentInfo.filePath);
        const targetOffsetRange = content ? this.componentIndex.findPropTargetOffset(content, propName) : null;

        if (!targetOffsetRange || !content) {
            return null;
        }

        const targetDocument = TextDocument.create(componentInfo.filePath, 'html', 0, content);
        const targetRange = Range.create(
            targetDocument.positionAt(targetOffsetRange.start),
            targetDocument.positionAt(targetOffsetRange.end)
        );

        return [{
            originSelectionRange,
            targetUri: URI.file(componentInfo.filePath).toString(),
            targetRange,
            targetSelectionRange: targetRange
        }];
    }

    private findClosingTagAtOffset(
        content: string, 
        offset: number
    ): { name: string; start: number; end: number } | null {
        const searchStart = Math.max(0, offset - 50);
        const searchEnd = Math.min(content.length, offset + 50);
        const searchArea = content.substring(searchStart, searchEnd);
        
        const closingTagRegex = /<\/c-([\w.-]+)>/g;
        let match;

        while ((match = closingTagRegex.exec(searchArea)) !== null) {
            const matchStart = searchStart + match.index;
            const matchEnd = matchStart + match[0].length;
            
            if (offset >= matchStart && offset <= matchEnd) {
                // Return the range of the full tag including </c-
                const tagStart = matchStart + 2; // Skip '</'
                const tagEnd = matchEnd - 1; // Exclude '>'
                return {
                    name: match[1],
                    start: tagStart,
                    end: tagEnd
                };
            }
        }

        return null;
    }
}
