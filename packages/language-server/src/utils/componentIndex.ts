import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';

const COTTON_BUILTIN_DIRECTIVES = ['vars', 'slot', 'component'];

export interface CVarDefinition {
    name: string;
    defaultValue: string;
    isDjangoExpression: boolean;
}

export interface ComponentInfo {
    name: string;
    filePath: string;
    cVars: CVarDefinition[];
}

export class ComponentIndex {
    private workspaceRoot: string;
    private templatePatterns: string[];
    private resolvedPathsCache: string[] | null = null;
    private cache: Map<string, ComponentInfo | null> = new Map();
    private allComponentsCache: ComponentInfo[] | null = null;

    constructor(workspaceRoot: string, templatePatterns: string[] = ['templates/cotton']) {
        this.workspaceRoot = workspaceRoot;
        this.templatePatterns = templatePatterns;
    }

    updateSettings(templatePatterns: string[]) {
        if (JSON.stringify(this.templatePatterns) !== JSON.stringify(templatePatterns)) {
            this.templatePatterns = templatePatterns;
            this.invalidateCache();
        }
    }

    invalidateCache() {
        this.cache.clear();
        this.allComponentsCache = null;
        this.resolvedPathsCache = null;
    }

    isBuiltinDirective(name: string): boolean {
        return COTTON_BUILTIN_DIRECTIVES.includes(name);
    }

    /**
     * Resolve glob patterns to actual directory paths
     */
    private async resolveTemplatePaths(): Promise<string[]> {
        if (this.resolvedPathsCache) {
            return this.resolvedPathsCache;
        }

        const resolvedPaths: string[] = [];

        for (const pattern of this.templatePatterns) {
            // Check if pattern contains glob characters
            if (this.isGlobPattern(pattern)) {
                // Use fast-glob to find matching directories
                const matches = await fg(pattern, {
                    cwd: this.workspaceRoot,
                    onlyDirectories: true,
                    absolute: false
                });
                resolvedPaths.push(...matches);
            } else {
                // Plain path - just use as-is
                resolvedPaths.push(pattern);
            }
        }

        // Remove duplicates
        this.resolvedPathsCache = [...new Set(resolvedPaths)];
        return this.resolvedPathsCache;
    }

    private isGlobPattern(pattern: string): boolean {
        return /[*?{}[\]]/.test(pattern);
    }

    async findComponent(componentName: string): Promise<ComponentInfo | null> {
        if (this.cache.has(componentName)) {
            return this.cache.get(componentName) || null;
        }

        const filePath = await this.findComponentFile(componentName);
        if (!filePath) {
            this.cache.set(componentName, null);
            return null;
        }

        const cVars = await this.parseCVars(filePath);
        const info: ComponentInfo = {
            name: componentName,
            filePath,
            cVars
        };

        this.cache.set(componentName, info);
        return info;
    }

    async getAllComponents(): Promise<ComponentInfo[]> {
        if (this.allComponentsCache) {
            return this.allComponentsCache;
        }

        const components: ComponentInfo[] = [];
        const templatePaths = await this.resolveTemplatePaths();

        for (const templateBasePath of templatePaths) {
            const fullTemplatePath = path.join(this.workspaceRoot, templateBasePath);
            try {
                await this.collectTemplateFiles(fullTemplatePath, '', components);
            } catch {
                // Directory doesn't exist, skip
            }
        }

        this.allComponentsCache = components;
        return components;
    }

    private async findComponentFile(componentName: string): Promise<string | undefined> {
        const tagPath = componentName.replace(/\./g, '/');
        const pathVariations = [
            tagPath,
            tagPath.replace(/-/g, '_'),
            tagPath.replace(/_/g, '-')
        ];

        const templatePaths = await this.resolveTemplatePaths();

        for (const templateBasePath of templatePaths) {
            for (const pathVariation of pathVariations) {
                const templatePath = path.join(this.workspaceRoot, templateBasePath, pathVariation + '.html');
                try {
                    await fs.promises.access(templatePath);
                    return templatePath;
                } catch {
                    const indexPath = path.join(this.workspaceRoot, templateBasePath, pathVariation, 'index.html');
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

    private async collectTemplateFiles(basePath: string, relativePath: string, items: ComponentInfo[]): Promise<void> {
        try {
            const entries = await fs.promises.readdir(path.join(basePath, relativePath), { withFileTypes: true });

            for (const entry of entries) {
                const currentRelativePath = path.join(relativePath, entry.name);

                if (entry.isDirectory()) {
                    const indexPath = path.join(basePath, currentRelativePath, 'index.html');
                    try {
                        await fs.promises.access(indexPath);
                        const componentName = currentRelativePath.replace(/[\\/]/g, '.').replace(/_/g, '-');
                        const cVars = await this.parseCVars(indexPath);
                        items.push({
                            name: componentName,
                            filePath: indexPath,
                            cVars
                        });
                    } catch {
                        // No index.html
                    }
                    
                    await this.collectTemplateFiles(basePath, currentRelativePath, items);
                } else if (entry.isFile() && entry.name.endsWith('.html') && entry.name !== 'index.html') {
                    const componentName = currentRelativePath.slice(0, -5).replace(/[\\/]/g, '.').replace(/_/g, '-');
                    const filePath = path.join(basePath, currentRelativePath);
                    const cVars = await this.parseCVars(filePath);
                    items.push({
                        name: componentName,
                        filePath,
                        cVars
                    });
                }
            }
        } catch {
            // Directory not readable
        }
    }

    private async parseCVars(filePath: string): Promise<CVarDefinition[]> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const cVarsMatch = content.match(/<c-vars\s+([^>]+)>/);
            if (!cVarsMatch) return [];

            const cVars: CVarDefinition[] = [];
            const attributeRegex = /(:?)(\w(?:[\w-]*\w)?)(?:=["']([^"']*)["'])?/g;
            let match;

            while ((match = attributeRegex.exec(cVarsMatch[1])) !== null) {
                cVars.push({
                    name: match[2],
                    defaultValue: match[3] || '',
                    isDjangoExpression: match[1] === ':'
                });
            }

            return cVars;
        } catch {
            return [];
        }
    }

    async getComponentFileContent(filePath: string): Promise<string | null> {
        try {
            return await fs.promises.readFile(filePath, 'utf-8');
        } catch {
            return null;
        }
    }

    /**
     * Locate where a prop is best "defined" within a component file, for go-to-definition
     * on an attribute name at a usage site:
     *   1. The prop's declaration inside <c-vars ...>, if present.
     *   2. Otherwise, the first place the prop is referenced in the file (e.g. {{ prop }}).
     *   3. Otherwise, null (caller should fall back to the top of the file).
     *
     * Cotton exposes kebab-cased attributes as their snake_case equivalent inside the
     * template (e.g. `icon-name` -> `{{ icon_name }}`), since `{{ }}` expressions can't
     * contain hyphens. We match against both forms so navigation works either way.
     */
    findPropTargetOffset(content: string, propName: string): { start: number; end: number } | null {
        const nameVariants = [...new Set([propName, propName.replace(/-/g, '_'), propName.replace(/_/g, '-')])];
        const cVarsMatch = content.match(/<c-vars\s+([^>]+)>/);

        if (cVarsMatch) {
            const groupOffset = cVarsMatch.index! + cVarsMatch[0].indexOf(cVarsMatch[1]);
            const attributeRegex = /(:?)(\w(?:[\w-]*\w)?)(?:=["']([^"']*)["'])?/g;
            let match;

            while ((match = attributeRegex.exec(cVarsMatch[1])) !== null) {
                if (nameVariants.includes(match[2])) {
                    const nameStart = groupOffset + match.index + match[1].length;
                    return { start: nameStart, end: nameStart + match[2].length };
                }
            }
        }

        const searchFrom = cVarsMatch ? cVarsMatch.index! + cVarsMatch[0].length : 0;
        const usageRegex = new RegExp(`\\b(?:${nameVariants.map(v => this.escapeRegex(v)).join('|')})\\b`, 'g');
        usageRegex.lastIndex = searchFrom;
        const usageMatch = usageRegex.exec(content);

        if (usageMatch) {
            return { start: usageMatch.index, end: usageMatch.index + usageMatch[0].length };
        }

        return null;
    }

    private static readonly RESERVED_TEMPLATE_NAMES = new Set([
        'slot', 'attrs', 'forloop', 'True', 'False', 'None', 'request', 'user', 'perms', 'messages'
    ]);

    /**
     * Heuristically collect every variable name a component's body references via
     * `{{ name }}` or `{% if name %}` (the two patterns Cotton slots are actually rendered
     * through). Shared by slot-name completion and slot-name validation.
     */
    private async getReferencedVariableNames(filePath: string): Promise<Set<string>> {
        const content = await this.getComponentFileContent(filePath);
        if (!content) return new Set();

        const bodyContent = content.replace(/<c-vars\s+[^>]+>/, '');
        const names = new Set<string>();
        const patterns = [/\{\{\s*([a-zA-Z_]\w*)/g, /\{%\s*if\s+([a-zA-Z_]\w*)/g];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(bodyContent)) !== null) {
                names.add(match[1]);
            }
        }

        return names;
    }

    /**
     * Heuristically find candidate named-slot identifiers for a component: variables it
     * references in its body ({{ name }}, {% if name %}) that aren't declared c-vars, the
     * default slot, or common template globals. Used to power completion inside <c-slot name="">.
     */
    async getSlotCandidates(filePath: string, excludeNames: Set<string>): Promise<string[]> {
        const referenced = await this.getReferencedVariableNames(filePath);
        return [...referenced].filter(
            name => !ComponentIndex.RESERVED_TEMPLATE_NAMES.has(name) && !excludeNames.has(name)
        );
    }

    /**
     * Whether `<c-slot name="slotName">` actually does something for this component, i.e.
     * whether its body references that name via `{{ slotName }}` or `{% if slotName %}`
     * anywhere. Used to flag likely-typo'd slot names as a diagnostic. This is a heuristic
     * (same patterns as getSlotCandidates) so it won't catch every possible usage (e.g. a name
     * only referenced through `{% with %}` or `{% for %}`), but keeps false positives low.
     */
    async hasSlotReference(filePath: string, slotName: string): Promise<boolean> {
        const referenced = await this.getReferencedVariableNames(filePath);
        return referenced.has(slotName);
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    async getComponentDocumentation(filePath: string): Promise<string | undefined> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const firstLine = content.split('\n')[0].trim();
            if (firstLine.startsWith('<!--') && firstLine.endsWith('-->')) {
                return firstLine.slice(4, -3).trim();
            }
            return undefined;
        } catch {
            return undefined;
        }
    }
}
