import {
    Hover,
    MarkupKind,
    Position
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CottonParser } from '../cottonParser';
import { ComponentIndex, CVarDefinition } from '../utils/componentIndex';

export class HoverHandler {
    constructor(
        private parser: CottonParser,
        private componentIndex: ComponentIndex
    ) {}

    async handleHover(document: TextDocument, position: Position): Promise<Hover | null> {
        const content = document.getText();
        const offset = document.offsetAt(position);
        const htmlDoc = this.parser.parseDocument(content, document.uri);

        const component = this.parser.findComponentAtOffset(htmlDoc, offset);
        if (!component || this.componentIndex.isBuiltinDirective(component.name)) {
            return null;
        }

        const tagNameRange = this.parser.getTagNameRange(component.node);
        const overTagName = !!tagNameRange && offset >= tagNameRange.start && offset <= tagNameRange.end;

        const attributeMatch = this.parser.findAttributeNameAtOffset(content, component.node, offset);

        if (!overTagName && !attributeMatch) {
            return null;
        }

        const componentInfo = await this.componentIndex.findComponent(component.name);
        if (!componentInfo) {
            return null;
        }

        if (attributeMatch) {
            const cVar = componentInfo.cVars.find(v => v.name === attributeMatch.name);
            if (!cVar) {
                return null;
            }
            return {
                contents: {
                    kind: MarkupKind.Markdown,
                    value: this.renderPropDoc(cVar)
                }
            };
        }

        const doc = await this.componentIndex.getComponentDocumentation(componentInfo.filePath);
        return {
            contents: {
                kind: MarkupKind.Markdown,
                value: this.renderComponentDoc(component.name, doc, componentInfo.cVars)
            }
        };
    }

    private renderComponentDoc(name: string, doc: string | undefined, cVars: CVarDefinition[]): string {
        const lines: string[] = [`**\`<c-${name}>\`**`];

        if (doc) {
            lines.push('', doc);
        }

        if (cVars.length > 0) {
            lines.push('', '**Props:**');
            for (const cVar of cVars) {
                const defaultText = cVar.defaultValue ? ` = \`${cVar.defaultValue}\`` : '';
                lines.push(`- \`${cVar.name}\`${defaultText}`);
            }
        }

        return lines.join('\n');
    }

    private renderPropDoc(cVar: CVarDefinition): string {
        const lines = [`**${cVar.name}**`, ''];
        lines.push(`Default: \`${cVar.defaultValue || 'undefined'}\``);
        if (!cVar.defaultValue && !cVar.isDjangoExpression) {
            lines.push('', 'Can be passed as a boolean flag (no value = `True`).');
        }
        return lines.join('\n');
    }
}
