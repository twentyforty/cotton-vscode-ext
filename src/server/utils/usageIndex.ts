import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';
import { Location, Range, Position } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

interface UsageEntry {
    componentName: string;
    uri: string;
    range: Range;
}

/**
 * Workspace-wide index of where every Cotton component is *used* (as opposed to
 * ComponentIndex, which tracks where components are *defined*). Powers "Find All
 * References" and unused-component detection.
 *
 * Performance approach:
 * - A full workspace scan only happens once, lazily, in the background.
 * - After that, individual file edits/saves update the index incrementally by
 *   re-scanning only the changed file (cheap: proportional to that file's size),
 *   not the whole workspace.
 */
export class UsageIndex {
    private workspaceRoot: string;
    private usagesByComponent: Map<string, UsageEntry[]> = new Map();
    private componentsByUri: Map<string, Set<string>> = new Map();
    private builtPromise: Promise<void> | null = null;
    private onChangeCallbacks: (() => void)[] = [];

    private static readonly IGNORE_GLOBS = [
        '**/node_modules/**',
        '**/.git/**',
        '**/venv/**',
        '**/.venv/**',
        '**/__pycache__/**',
        '**/out/**',
        '**/dist/**',
        '**/build/**',
        '**/.vscode-test/**'
    ];

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    onChange(callback: () => void): void {
        this.onChangeCallbacks.push(callback);
    }

    private notifyChange(): void {
        this.onChangeCallbacks.forEach(cb => cb());
    }

    /**
     * Kick off (or await, if already running) the initial full-workspace scan.
     * Safe to call multiple times - subsequent calls just await the same promise.
     */
    async ensureBuilt(): Promise<void> {
        if (!this.builtPromise) {
            this.builtPromise = this.buildFullIndex();
        }
        return this.builtPromise;
    }

    rebuild(): void {
        this.builtPromise = this.buildFullIndex();
    }

    private async buildFullIndex(): Promise<void> {
        this.usagesByComponent = new Map();
        this.componentsByUri = new Map();

        let files: string[];
        try {
            files = await fg('**/*.html', {
                cwd: this.workspaceRoot,
                absolute: true,
                ignore: UsageIndex.IGNORE_GLOBS,
                onlyFiles: true
            });
        } catch {
            files = [];
        }

        // Read/scan in small concurrent batches so we don't open thousands of file
        // handles at once on very large workspaces, while still parallelizing I/O.
        const BATCH_SIZE = 25;
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
            const batch = files.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async filePath => {
                try {
                    const content = await fs.promises.readFile(filePath, 'utf-8');
                    this.indexFileContent(URI.file(filePath).toString(), content);
                } catch {
                    // Unreadable file, skip
                }
            }));
        }

        this.notifyChange();
    }

    /**
     * Incrementally re-index a single file (called on document open/change/save).
     * Cheap: only rescans the one file, not the whole workspace.
     */
    updateFile(uri: string, content: string): void {
        this.removeFile(uri);
        this.indexFileContent(uri, content);
        this.notifyChange();
    }

    removeFile(uri: string): void {
        const previousComponents = this.componentsByUri.get(uri);
        if (!previousComponents) return;

        for (const name of previousComponents) {
            const entries = this.usagesByComponent.get(name);
            if (!entries) continue;
            const filtered = entries.filter(e => e.uri !== uri);
            if (filtered.length > 0) {
                this.usagesByComponent.set(name, filtered);
            } else {
                this.usagesByComponent.delete(name);
            }
        }

        this.componentsByUri.delete(uri);
    }

    private indexFileContent(uri: string, content: string): void {
        const componentNamesInFile = new Set<string>();
        // Computed once per file, then reused via binary search for every offset->position
        // conversion below, so indexing a file stays roughly O(size + usages log lines).
        const newlineOffsets = this.computeNewlineOffsets(content);

        // Doc comments routinely show example usage (e.g. `<!-- rendered as <c-card /> -->`,
        // exactly the pattern getComponentDocumentation()/hover encourage). Blank out comment
        // bodies (preserving length and newlines, so offsets stay valid) before scanning, so
        // documentation examples don't get counted as real usages.
        const scannable = this.stripComments(content);

        // <c-foo ...> and <c-foo /> opening tags
        const tagRegex = /<c-([\w.-]+)/g;
        let match;
        while ((match = tagRegex.exec(scannable)) !== null) {
            const name = match[1];
            if (name === 'vars' || name === 'slot' || name === 'component') continue;

            const start = match.index + 1; // skip '<', keep the "c-foo" span (tag name incl. prefix)
            const end = start + 2 + name.length;
            this.addUsage(name, uri, newlineOffsets, start, end);
            componentNamesInFile.add(name);
        }

        // <c-component is="literal.name" /> - static dynamic-component usages.
        // Note: requires whitespace (not just a word boundary) immediately before "is", so
        // the colon-prefixed dynamic-expression form (`:is="expr"`) is correctly excluded -
        // a plain `\b` would also match right after the colon.
        const isAttrRegex = /<c-component\b[^>]*?\sis\s*=\s*"([^"{}%]*)"/g;
        while ((match = isAttrRegex.exec(scannable)) !== null) {
            const name = match[1];
            if (!name) continue;
            const valueStart = match.index + match[0].lastIndexOf(name);
            const valueEnd = valueStart + name.length;
            this.addUsage(name, uri, newlineOffsets, valueStart, valueEnd);
            componentNamesInFile.add(name);
        }

        if (componentNamesInFile.size > 0) {
            this.componentsByUri.set(uri, componentNamesInFile);
        }
    }

    private addUsage(componentName: string, uri: string, newlineOffsets: number[], start: number, end: number): void {
        const range = Range.create(
            this.offsetToPosition(newlineOffsets, start),
            this.offsetToPosition(newlineOffsets, end)
        );

        const entries = this.usagesByComponent.get(componentName) || [];
        entries.push({ componentName, uri, range });
        this.usagesByComponent.set(componentName, entries);
    }

    private stripComments(content: string): string {
        return content.replace(/<!--[\s\S]*?-->/g, comment => comment.replace(/[^\n]/g, ' '));
    }

    private computeNewlineOffsets(content: string): number[] {
        const offsets: number[] = [];
        for (let i = 0; i < content.length; i++) {
            if (content.charCodeAt(i) === 10 /* \n */) {
                offsets.push(i);
            }
        }
        return offsets;
    }

    /** Binary search over precomputed newline offsets - O(log lines) per conversion. */
    private offsetToPosition(newlineOffsets: number[], offset: number): Position {
        let lo = 0;
        let hi = newlineOffsets.length;

        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (newlineOffsets[mid] < offset) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }

        const line = lo;
        const lineStart = line === 0 ? 0 : newlineOffsets[line - 1] + 1;
        return Position.create(line, offset - lineStart);
    }

    /**
     * All Locations where the given component name is used, across the workspace.
     */
    getReferences(componentName: string): Location[] {
        const entries = this.usagesByComponent.get(componentName) || [];
        return entries.map(e => Location.create(e.uri, e.range));
    }

    getUsageCount(componentName: string): number {
        return this.usagesByComponent.get(componentName)?.length || 0;
    }

    /**
     * File paths (absolute, fs-style) of every known component that has zero usages
     * anywhere in the indexed workspace files.
     */
    getUnusedComponentPaths(allComponentFilePaths: { name: string; filePath: string }[]): string[] {
        return allComponentFilePaths
            .filter(c => this.getUsageCount(c.name) === 0)
            .map(c => path.normalize(c.filePath));
    }
}
