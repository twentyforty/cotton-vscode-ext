import {
    Diagnostic,
    DiagnosticSeverity,
    Range
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CottonParser } from '../cottonParser';
import { ComponentIndex } from '../utils/componentIndex';

export class DiagnosticsHandler {
    constructor(
        private parser: CottonParser,
        private componentIndex: ComponentIndex
    ) {}

    async getDiagnostics(document: TextDocument): Promise<Diagnostic[]> {
        const content = document.getText();
        const htmlDoc = this.parser.parseDocument(content, document.uri);
        const components = this.parser.findCottonComponents(htmlDoc);
        
        const diagnostics: Diagnostic[] = [];

        for (const component of components) {
            // <c-component is="literal-name" /> - only validate when `is` is a static string;
            // dynamic expressions (`:is="..."`) or embedded template syntax can't be checked here.
            if (component.name === 'component') {
                const isAttr = this.parser.getAttributeValue(content, component.node, 'is');
                if (isAttr && !isAttr.hasColon && !/[{}%]/.test(isAttr.value)) {
                    const componentInfo = await this.componentIndex.findComponent(isAttr.value);
                    if (!componentInfo) {
                        diagnostics.push({
                            severity: DiagnosticSeverity.Error,
                            range: Range.create(
                                document.positionAt(isAttr.start),
                                document.positionAt(isAttr.end)
                            ),
                            message: `Cotton component '${isAttr.value}' not found`,
                            source: 'Cotton',
                            code: 'cotton-component-not-found'
                        });
                    }
                }
                continue;
            }

            if (this.componentIndex.isBuiltinDirective(component.name)) {
                continue;
            }

            const componentInfo = await this.componentIndex.findComponent(component.name);
            
            if (!componentInfo) {
                const tagContent = content.substring(component.startOffset);
                const tagNameEndMatch = tagContent.match(/^<c-[\w.-]+/);
                
                const tagEndOffset = tagNameEndMatch 
                    ? component.startOffset + tagNameEndMatch[0].length
                    : component.startOffset + component.fullTag.length + 1;

                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: Range.create(
                        document.positionAt(component.startOffset),
                        document.positionAt(tagEndOffset)
                    ),
                    message: `Cotton component '${component.name}' not found`,
                    source: 'Cotton',
                    code: 'cotton-component-not-found'
                });
            }
        }

        return diagnostics;
    }
}
