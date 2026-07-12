# Django Cotton

Monorepo for Django Cotton editor tooling.

## Packages

| Package | Description |
|---------|-------------|
| [`django-cotton-lsp`](./packages/language-server) | Editor-agnostic LSP server (publishable to npm) |
| [`django-cotton`](./packages/vscode-extension) | VS Code extension (thin client around the language server) |

## Development

```bash
npm install
npm run compile
```

Press **F5** in VS Code to launch the extension against the `test-workspace/` fixture.

### Publish the language server

```bash
npm publish -w django-cotton-lsp
```

### Package the VS Code extension

Do **not** run `vsce publish` directly from `packages/vscode-extension` in the monorepo — it will follow workspace symlinks and bundle the whole repo. Use:

```bash
npm run package:extension
```

This produces `packages/vscode-extension/django-cotton-1.0.1.vsix` with only the extension and its npm dependencies.

### Publish to the VS Code Marketplace

```bash
npm run publish:extension
```

Or package first, then publish the VSIX manually:

```bash
npm run package:extension
npx @vscode/vsce publish -i packages/vscode-extension/django-cotton-1.0.1.vsix
```
