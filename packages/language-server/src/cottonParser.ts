import {
    getLanguageService,
    HTMLDocument,
    Node,
    LanguageService
} from 'vscode-html-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';

export interface CottonComponent {
    name: string;          // Component name without 'c-' prefix
    fullTag: string;       // Full tag name including 'c-'
    node: Node;            // The HTML node
    startOffset: number;
    endOffset: number;
}

export interface CursorContext {
    isInsideCottonTag: boolean;
    componentName: string | null;
    isTypingTagName: boolean;
    partialTagName: string | null;
    partialAttributeName: string | null;
    existingAttributes: Set<string>;
}

export class CottonParser {
    private htmlLanguageService: LanguageService;

    constructor() {
        this.htmlLanguageService = getLanguageService();
    }

    parseDocument(content: string, uri: string): HTMLDocument {
        const textDocument = TextDocument.create(uri, 'html', 1, content);
        return this.htmlLanguageService.parseHTMLDocument(textDocument);
    }

    findCottonComponents(htmlDoc: HTMLDocument): CottonComponent[] {
        const components: CottonComponent[] = [];
        
        const walk = (node: Node) => {
            if (node.tag?.startsWith('c-')) {
                components.push({
                    name: node.tag.slice(2),
                    fullTag: node.tag,
                    node,
                    startOffset: node.start,
                    endOffset: node.end
                });
            }
            node.children?.forEach(walk);
        };

        htmlDoc.roots.forEach(walk);
        return components;
    }

    findComponentAtOffset(htmlDoc: HTMLDocument, offset: number): CottonComponent | null {
        const node = htmlDoc.findNodeAt(offset);
        
        if (node?.tag?.startsWith('c-')) {
            return {
                name: node.tag.slice(2),
                fullTag: node.tag,
                node,
                startOffset: node.start,
                endOffset: node.end
            };
        }

        return null;
    }

    getCursorContext(content: string, offset: number, htmlDoc: HTMLDocument): CursorContext {
        const result: CursorContext = {
            isInsideCottonTag: false,
            componentName: null,
            isTypingTagName: false,
            partialTagName: null,
            partialAttributeName: null,
            existingAttributes: new Set()
        };

        // Check if we're typing a new tag (after '<c-')
        const textBeforeCursor = content.substring(0, offset);
        const tagTypingMatch = textBeforeCursor.match(/<c-([\w.-]*)$/);
        
        if (tagTypingMatch) {
            result.isTypingTagName = true;
            result.partialTagName = tagTypingMatch[1];
            return result;
        }

        // Find if we're inside a Cotton tag
        const node = htmlDoc.findNodeAt(offset);
        
        if (node?.tag?.startsWith('c-')) {
            const tagEndOffset = this.findTagEndOffset(content, node.start);
            
            if (offset <= tagEndOffset) {
                result.isInsideCottonTag = true;
                result.componentName = node.tag.slice(2);
                result.existingAttributes = new Set(Object.keys(node.attributes || {}));

                // Check if we're typing an attribute
                const attrMatch = this.getPartialAttribute(content, offset);
                if (attrMatch) {
                    result.partialAttributeName = attrMatch;
                }
            }
        }

        return result;
    }

    getTagNameRange(node: Node): { start: number; end: number } | null {
        if (!node.tag?.startsWith('c-')) return null;

        const tagStart = node.start + 1; // Skip '<'
        const tagEnd = tagStart + node.tag.length;

        return { start: tagStart, end: tagEnd };
    }

    /**
     * Find the attribute name token (e.g. `label`, `:count`, or the escaped `::class`) at the
     * given offset, within the opening tag of the given node. Returns null if the offset isn't
     * over an attribute name (e.g. it's over the tag name, an attribute value, or outside the tag).
     */
    findAttributeNameAtOffset(content: string, node: Node, offset: number): { name: string; hasColon: boolean; start: number; end: number } | null {
        if (!node.tag) return null;

        const tagEnd = this.findTagEndOffset(content, node.start);
        if (offset < node.start || offset > tagEnd) return null;

        const nameSearchStart = node.start + 1 + node.tag.length; // skip '<' and tag name
        const tagContent = content.substring(nameSearchStart, tagEnd);

        const attrRegex = /(:{0,2}[a-zA-Z_][\w-]*)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
        let match;

        while ((match = attrRegex.exec(tagContent)) !== null) {
            const fullName = match[1];
            const nameStart = nameSearchStart + match.index;
            const nameEnd = nameStart + fullName.length;

            if (offset >= nameStart && offset <= nameEnd) {
                // `::foo` is an escaped literal attribute (e.g. Alpine.js `::class`), not a
                // Cotton dynamic-expression attribute - only a single leading `:` means dynamic.
                const isEscaped = fullName.startsWith('::');
                const hasColon = !isEscaped && fullName.startsWith(':');
                const strippedName = fullName.replace(/^:+/, '');

                return {
                    name: strippedName,
                    hasColon,
                    start: nameStart,
                    end: nameEnd
                };
            }
        }

        return null;
    }

    /**
     * Find the value (and its offset span) of a specific attribute on the opening tag of the
     * given node, e.g. reading `is="foo"` off a `<c-component is="foo" />` tag. Returns null if
     * the attribute isn't present or has no quoted value.
     */
    getAttributeValue(content: string, node: Node, attrName: string): { value: string; hasColon: boolean; start: number; end: number } | null {
        if (!node.tag) return null;

        const tagEnd = this.findTagEndOffset(content, node.start);
        const nameSearchStart = node.start + 1 + node.tag.length;
        const tagContent = content.substring(nameSearchStart, tagEnd);

        const escapedAttrName = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const attrRegex = new RegExp(`(:?)${escapedAttrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
        const match = attrRegex.exec(tagContent);
        if (!match) return null;

        const value = match[2] !== undefined ? match[2] : match[3];
        const quoteOffsetInMatch = match[0].length - value.length - 1; // just before the closing quote
        const valueStart = nameSearchStart + match.index + quoteOffsetInMatch;

        return {
            value,
            hasColon: match[1] === ':',
            start: valueStart,
            end: valueStart + value.length
        };
    }

    /**
     * If the given node is a <c-slot> tag and the offset is inside its `name` attribute value,
     * return the slot name and the enclosing Cotton component (so callers can look up what slot
     * names that component actually expects, or navigate to where it consumes this slot).
     */
    getSlotNameContext(content: string, node: Node, offset: number): { componentName: string; slotName: string; valueStart: number; valueEnd: number } | null {
        if (node.tag !== 'c-slot') return null;

        const nameAttr = this.getAttributeValue(content, node, 'name');
        if (!nameAttr || offset < nameAttr.start || offset > nameAttr.end) return null;

        const componentName = this.findEnclosingComponentName(node);
        if (!componentName) return null;

        return {
            componentName,
            slotName: nameAttr.value,
            valueStart: nameAttr.start,
            valueEnd: nameAttr.end
        };
    }

    /**
     * Walk up from a node to find the nearest ancestor that's a real Cotton component tag
     * (skipping the built-in `<c-vars>`/`<c-slot>`/`<c-component>` directives) - e.g. to find
     * which component a `<c-slot>` belongs to.
     */
    findEnclosingComponentName(node: Node): string | null {
        let ancestor = node.parent;
        while (ancestor) {
            if (ancestor.tag?.startsWith('c-') && !['c-vars', 'c-slot', 'c-component'].includes(ancestor.tag)) {
                return ancestor.tag.slice(2);
            }
            ancestor = ancestor.parent;
        }
        return null;
    }

    findTagEndOffset(content: string, tagStart: number): number {
        let i = tagStart;
        let inQuote = false;
        let quoteChar = '';

        while (i < content.length) {
            const char = content[i];

            if (inQuote) {
                if (char === quoteChar) {
                    inQuote = false;
                }
            } else {
                if (char === '"' || char === "'") {
                    inQuote = true;
                    quoteChar = char;
                } else if (char === '>') {
                    return i;
                }
            }
            i++;
        }

        return content.length;
    }

    private getPartialAttribute(content: string, offset: number): string | null {
        let start = offset;
        
        while (start > 0) {
            const char = content[start - 1];
            if (char === ' ' || char === '\t' || char === '\n') break;
            if (char === '=' || char === '"' || char === "'" || char === '>' || char === '<') return null;
            start--;
        }
        
        const partial = content.substring(start, offset);
        
        if (partial.length > 0 && /^:{0,2}[a-zA-Z_][\w.-]*$/.test(partial)) {
            return partial;
        }
        
        return null;
    }
}
