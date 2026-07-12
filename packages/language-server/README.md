# django-cotton-lsp

Language Server for [Django Cotton](https://django-cotton.com/) templates. Powers the [Django Cotton VS Code extension](https://marketplace.visualstudio.com/) and any other LSP-capable editor.

## Install

```bash
npm install -g django-cotton-lsp
```

## Usage

The server communicates over stdio (standard LSP transport):

```bash
django-cotton-lsp
```

### Neovim (nvim-lspconfig)

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')

if not configs.cotton_ls then
  configs.cotton_ls = {
    default_config = {
      cmd = { 'django-cotton-lsp' },
      filetypes = { 'html', 'django-html' },
      root_dir = function(fname)
        return lspconfig.util.root_pattern('manage.py', 'pyproject.toml', '.git')(fname)
      end,
      settings = {},
    },
  }
end

lspconfig.cotton_ls.setup({
  init_options = {
    templatePaths = { 'templates/cotton' },
  },
})
```

### Helix

```toml
[[language-server.cotton]]
command = "django-cotton-lsp"
language-id = "html"
```

## Configuration

Settings are resolved with this priority:

1. Editor LSP settings / `initializationOptions`
2. `cotton.config.json` in the workspace root
3. Built-in default (`templates/cotton`)

### cotton.config.json

```json
{
    "templatePaths": [
        "templates/cotton",
        "apps/*/templates/cotton"
    ]
}
```

`templatePaths` accepts plain directories and glob patterns.

## Features

- Go to definition (components, props, slots, dynamic `<c-component is="...">`)
- Autocompletion (components, directives, props, slots)
- Hover documentation
- Find all references
- Diagnostics (missing components, slot name typos)

## VS Code extension

For VS Code-specific features (unused component badges, Explorer context menu), use the [Django Cotton extension](https://github.com/twentyforty/cotton-vscode-ext/tree/main/packages/vscode-extension) instead of wiring the server manually.
