"use strict";
// import * as vscode from 'vscode';
// import * as path from 'path';
// import * as fs from 'fs';
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
// export function activate(context: vscode.ExtensionContext) {
//     const provider = new CottonDefinitionProvider();
//     let disposable = vscode.languages.registerDefinitionProvider(
//         ['html', 'django-html'],
//         provider
//     );
//     context.subscriptions.push(disposable);
// }
// class CottonDefinitionProvider implements vscode.DefinitionProvider {
//     async provideDefinition(
//         document: vscode.TextDocument,
//         position: vscode.Position,
//         token: vscode.CancellationToken
//     ): Promise<vscode.DefinitionLink[] | undefined> {
//         const line = document.lineAt(position.line).text;
//         const char = position.character;
//         // Find the start of the tag before the cursor
//         let tagStart = line.lastIndexOf('<', char);
//         if (tagStart === -1) return undefined;
//         // Find the end of the tag
//         let tagEnd = line.indexOf('>', tagStart);
//         if (tagEnd === -1) return undefined;
//         // Get the full tag text
//         const fullTag = line.substring(tagStart, tagEnd + 1);
//         // Check if it's a cotton tag
//         if (!fullTag.startsWith('<c-') && !fullTag.startsWith('</c-')) {
//             return undefined;
//         }
//         // Extract just the component name (without < or attributes)
//         const componentMatch = fullTag.match(/^<\/?c-([\w.-]+)/);
//         if (!componentMatch) return undefined;
//         const componentName = componentMatch[1]; // This is just the component name without c- prefix
//         // Calculate the range for just the component name
//         const componentStart = tagStart + (fullTag.startsWith('</') ? 2 : 1); // Skip <c- or </c-
//         const componentEnd = componentStart + componentName.length + 2;
//         // Create a range that only includes the component name
//         const hoverRange = new vscode.Range(
//             new vscode.Position(position.line, componentStart),
//             new vscode.Position(position.line, componentEnd)
//         );
//         const tagPath = componentName.replace(/\./g, '/');
//         console.log('Extracted path:', tagPath);
//         const pathVariations = [
//             tagPath,                    // original
//             tagPath.replace(/-/g, '_'), // hyphens to underscores
//             tagPath.replace(/_/g, '-')  // underscores to hyphens
//         ];
//         const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
//         if (!workspaceFolder) return undefined;
//         const config = vscode.workspace.getConfiguration('cottonTemplateTags');
//         const templatePaths = config.get<string[]>('templatePaths', ['templates/cotton']);
//         for (const templateBasePath of templatePaths) {
//             for (const pathVariation of pathVariations) {
//                 const templatePath = path.join(
//                     workspaceFolder.uri.fsPath,
//                     templateBasePath,
//                     pathVariation + '.html'
//                 );
//                 try {
//                     await fs.promises.access(templatePath);
//                     return [
//                         {
//                             originSelectionRange: hoverRange,
//                             targetUri: vscode.Uri.file(templatePath),
//                             targetRange: new vscode.Range(0, 0, 0, 0),
//                             targetSelectionRange: new vscode.Range(0, 0, 0, 0)
//                         }
//                     ];
//                 } catch {
//                     continue;
//                 }
//             }
//         }
//         return undefined;
//     }
// }
// export function deactivate() {}
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const child_process = require("child_process");
const util_1 = require("util");
const exec = (0, util_1.promisify)(child_process.exec);
async function findDjangoSettings(workspaceRoot) {
    // Try to find manage.py to locate Django project root
    let projectRoot = workspaceRoot;
    let managePyPath = path.join(projectRoot, 'manage.py');
    while (!fs.existsSync(managePyPath) && projectRoot !== path.parse(projectRoot).root) {
        projectRoot = path.dirname(projectRoot);
        managePyPath = path.join(projectRoot, 'manage.py');
    }
    if (!fs.existsSync(managePyPath)) {
        console.log('Could not find manage.py');
        return null;
    }
    // Create a temporary Python script to read Cotton settings
    const tempScriptPath = path.join(projectRoot, 'temp_cotton_settings_reader.py');
    const pythonScript = `
import os
import sys
import json
from django.conf import settings

# Setup Django environment
sys.path.insert(0, '${projectRoot.replace(/\\/g, '\\\\')}')

# Try to find Django settings module
def find_settings_module():
    for root, dirs, files in os.walk('${projectRoot.replace(/\\/g, '\\\\')}'):
        if 'settings.py' in files:
            rel_path = os.path.relpath(root, '${projectRoot.replace(/\\/g, '\\\\')}')
            module_path = rel_path.replace(os.sep, '.') + '.settings'
            if module_path.startswith('.'):
                module_path = module_path[1:]
            return module_path
    return 'config.settings'  # Default fallback

settings_module = find_settings_module()
os.environ.setdefault('DJANGO_SETTINGS_MODULE', settings_module)

import django
django.setup()

# Get Cotton settings
cotton_settings = {
    'template_dirs': getattr(settings, 'COTTON_TEMPLATE_DIRS', ['templates/cotton']),
    'components_module': getattr(settings, 'COTTON_COMPONENTS_MODULE', 'cotton.components'),
    'tags_module': getattr(settings, 'COTTON_TAGS_MODULE', 'cotton.tags'),
}

print(json.dumps(cotton_settings))
`;
    try {
        // Write temporary script
        await fs.promises.writeFile(tempScriptPath, pythonScript);
        // Execute the script
        const { stdout } = await exec(`python ${tempScriptPath}`);
        // Parse the output
        const settings = JSON.parse(stdout.trim());
        // Convert relative template paths to absolute
        const templateDirs = settings.template_dirs.map((dir) => {
            if (path.isAbsolute(dir)) {
                return dir;
            }
            return path.join(projectRoot, dir);
        });
        return {
            templateDirs,
            componentsModule: settings.components_module,
            tagsModule: settings.tags_module
        };
    }
    catch (error) {
        console.error('Error reading Cotton settings:', error);
        return null;
    }
    finally {
        // Clean up temp script
        try {
            await fs.promises.unlink(tempScriptPath);
        }
        catch (error) {
            console.error('Error cleaning up temp script:', error);
        }
    }
}
class CottonDefinitionProvider {
    constructor() {
        this.settings = null;
    }
    async getCottonSettings(workspaceFolder) {
        // Cache the settings
        if (this.settings === null) {
            // First try Django settings
            this.settings = await findDjangoSettings(workspaceFolder.uri.fsPath);
            console.log('Django settings:', this.settings);
            // Fall back to default settings if Django settings not found
            if (this.settings === null) {
                this.settings = {
                    templateDirs: ['templates/cotton'],
                    componentsModule: 'cotton.components',
                    tagsModule: 'cotton.tags'
                };
            }
        }
        return this.settings;
    }
    async provideDefinition(document, position, token) {
        const line = document.lineAt(position.line).text;
        const char = position.character;
        // Find the start of the tag before the cursor
        let tagStart = line.lastIndexOf('<', char);
        if (tagStart === -1)
            return undefined;
        // Find the end of the tag
        let tagEnd = line.indexOf('>', tagStart);
        if (tagEnd === -1)
            return undefined;
        // Get the full tag text
        const fullTag = line.substring(tagStart, tagEnd + 1);
        // Check if it's a cotton tag
        if (!fullTag.startsWith('<c-') && !fullTag.startsWith('</c-')) {
            return undefined;
        }
        // Extract just the component name (without < or attributes)
        const componentMatch = fullTag.match(/^<\/?c-([\w.-]+)/);
        if (!componentMatch)
            return undefined;
        const componentName = componentMatch[1]; // This is just the component name without c- prefix
        // Calculate the range for just the component name
        const componentStart = tagStart + (fullTag.startsWith('</') ? 2 : 1); // Skip <c- or </c-
        const componentEnd = componentStart + componentName.length + 2;
        // Create a range that only includes the component name
        const hoverRange = new vscode.Range(new vscode.Position(position.line, componentStart), new vscode.Position(position.line, componentEnd));
        const tagPath = componentName.replace(/\./g, '/');
        console.log('Extracted path:', tagPath);
        const pathVariations = [
            tagPath, // original
            tagPath.replace(/-/g, '_'), // hyphens to underscores
            tagPath.replace(/_/g, '-') // underscores to hyphens
        ];
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder)
            return undefined;
        // Get Cotton settings
        const settings = await this.getCottonSettings(workspaceFolder);
        // Try each template directory
        for (const templateDir of settings.templateDirs) {
            for (const pathVariation of pathVariations) {
                const templatePath = path.join(templateDir, pathVariation + '.html');
                try {
                    await fs.promises.access(templatePath);
                    return [
                        {
                            originSelectionRange: hoverRange,
                            targetUri: vscode.Uri.file(templatePath),
                            targetRange: new vscode.Range(0, 0, 0, 0),
                            targetSelectionRange: new vscode.Range(0, 0, 0, 0)
                        }
                    ];
                }
                catch {
                    continue;
                }
            }
        }
        return undefined;
    }
}
function activate(context) {
    const provider = new CottonDefinitionProvider();
    let disposable = vscode.languages.registerDefinitionProvider(['html', 'django-html'], provider);
    context.subscriptions.push(disposable);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map