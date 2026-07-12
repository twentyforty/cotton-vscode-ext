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

            // <c-slot name="icon"> - flag a slot name that the enclosing component doesn't
            // actually reference anywhere (typo, renamed slot, etc). Only checked when the name
            // is a static string; dynamic (`:name="expr"`) or template-embedded values can't be
            // checked here.
            if (component.name === 'slot') {
                const nameAttr = this.parser.getAttributeValue(content, component.node, 'name');
                if (nameAttr && !nameAttr.hasColon && !/[{}%]/.test(nameAttr.value)) {
                    const enclosingComponentName = this.parser.findEnclosingComponentName(component.node);
                    const enclosingInfo = enclosingComponentName
                        ? await this.componentIndex.findComponent(enclosingComponentName)
                        : null;

                    if (enclosingInfo) {
                        const isReferenced = await this.componentIndex.hasSlotReference(enclosingInfo.filePath, nameAttr.value);
                        if (!isReferenced) {
                            diagnostics.push({
                                severity: DiagnosticSeverity.Warning,
                                range: Range.create(
                                    document.positionAt(nameAttr.start),
                                    document.positionAt(nameAttr.end)
                                ),
                                message: `Slot '${nameAttr.value}' doesn't appear to be used anywhere in <c-${enclosingComponentName}> (no {{ ${nameAttr.value} }} or {% if ${nameAttr.value} %} found). Check for a typo.`,
                                source: 'Cotton',
                                code: 'cotton-slot-not-referenced'
                            });
                        }
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
