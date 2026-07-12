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

```bash
npm run package:extension
cd packages/vscode-extension
npx @vscode/vsce publish
```
