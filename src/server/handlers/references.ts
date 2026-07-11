import {
    Location,
    Position,
    Range
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { HTMLDocument } from 'vscode-html-languageservice';
import { URI } from 'vscode-uri';
import { CottonParser } from '../cottonParser';
import { ComponentIndex } from '../utils/componentIndex';
import { UsageIndex } from '../utils/usageIndex';

export class ReferencesHandler {
    constructor(
        private parser: CottonParser,
        private componentIndex: ComponentIndex,
        private usageIndex: UsageIndex
    ) {}

    async handleReferences(
        document: TextDocument,
        position: Position,
        includeDeclaration: boolean
    ): Promise<Location[] | null> {
        const content = document.getText();
        const offset = document.offsetAt(position);
        const htmlDoc = this.parser.parseDocument(content, document.uri);

        const componentName = this.resolveComponentNameAtOffset(content, htmlDoc, offset);
        if (!componentName || this.componentIndex.isBuiltinDirective(componentName)) {
            return null;
        }

        await this.usageIndex.ensureBuilt();
        const references = this.usageIndex.getReferences(componentName);

        if (includeDeclaration) {
            const componentInfo = await this.componentIndex.findComponent(componentName);
            if (componentInfo) {
                references.push(Location.create(
                    URI.file(componentInfo.filePath).toString(),
                    Range.create(Position.create(0, 0), Position.create(0, 0))
                ));
            }
        }

        return references;
    }

    /**
     * Resolve the component name a "Find All References" invocation should target: the
     * tag name of a <c-foo> usage (opening or closing), or a static `is="foo"` value on
     * a <c-component> dynamic-component tag.
     */
    private resolveComponentNameAtOffset(content: string, htmlDoc: HTMLDocument, offset: number): string | null {
        const component = this.parser.findComponentAtOffset(htmlDoc, offset);
        if (!component) return null;

        if (component.name === 'component') {
            const isAttr = this.parser.getAttributeValue(content, component.node, 'is');
            if (
                isAttr && !isAttr.hasColon && !/[{}%]/.test(isAttr.value) &&
                offset >= isAttr.start && offset <= isAttr.end
            ) {
                return isAttr.value;
            }
            return null;
        }

        const tagNameRange = this.parser.getTagNameRange(component.node);
        if (tagNameRange && offset >= tagNameRange.start && offset <= tagNameRange.end) {
            return component.name;
        }

        if (component.node.endTagStart !== undefined) {
            const closingStart = component.node.endTagStart + 2;
            const closingEnd = closingStart + component.fullTag.length;
            if (offset >= closingStart && offset <= closingEnd) {
                return component.name;
            }
        }

        return null;
    }
}
