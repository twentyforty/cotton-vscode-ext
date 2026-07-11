# Django Cotton VS Code Extension

Comprehensive VS Code support for [Django Cotton](https://django-cotton.com/) templates, powered by a dedicated language server.

## Features

- **Go to Definition** - Navigate to a Cotton component's template, to a prop's `<c-vars>` declaration or first usage, to a dynamic `<c-component is="...">` target, or to where a `<c-slot name="...">` is consumed
- **Component & Directive Autocompletion** - Smart suggestions for available components as well as built-in `<c-vars>`, `<c-slot>`, and `<c-component>` directives
- **Parameter Intellisense** - Autocomplete component parameters from `<c-vars>`, including a boolean (valueless) variant for flag-style props, plus named-slot completion inside `<c-slot name="...">`
- **Hover Documentation** - Hover a component tag or prop to see its documentation, default value, and full prop list
- **Find All References** - Standard "Find All References" on a component usage, or right-click a component file in the Explorer to find every place it's used
- **Unused Component Detection** - Component files with no usages anywhere in the workspace are badged in the file explorer
- **Error Detection** - Highlights missing component files (including unresolved `<c-component is="...">` targets) and slot names that don't match anything the component actually references (likely typos)
- **Index.html Support** - Full support for Django Cotton's folder structure patterns
- **Any Editor** - Built as a language server, so the same intelligence can power other LSP-capable editors (Neovim, Sublime, etc.), not just VS Code

## Usage

### Go to Definition

Command/Ctrl+click any Cotton tag (e.g., `<c-ui.forms.input>`) to navigate to its template file.

Command/Ctrl+click a prop at a usage site (e.g. `title` in `<c-card title="...">`) to jump to its `<c-vars>` declaration, or its first usage inside the component if it isn't declared in `<c-vars>`. Props the component doesn't actually reference anywhere won't navigate at all.

Command/Ctrl+click a slot name in `<c-slot name="icon">` to jump to where the parent component consumes that slot.

### Component Autocompletion

Type `<c-` to see available components, plus the built-in `<c-vars>`, `<c-slot>`, and `<c-component>` directives. Continue typing to filter (e.g., `<c-form`).

### Parameter Autocompletion

Inside Cotton component tags, get intelligent suggestions for component parameters:

```html
<!-- In your component file: -->
<c-vars title="Default" :count="0" disabled />

<!-- When using the component: -->
<c-my-component |  <!-- Cursor here - shows: title, :title, count, :count, disabled, :disabled -->
```

### Hover

Hover any component tag or prop to see its documentation and default values without leaving the file.

### Find All References / Unused Components

- Right-click inside a component usage (or a component file itself) and choose **Find All References** / **Find Component Usages** to see every place a component is used across the workspace.
- Component files with zero usages anywhere in the workspace get a small "U" badge in the file explorer, making dead templates easy to spot.

## Configuration

```json
{
    "djangoCotton.templatePaths": [
        "templates/cotton",
        "other/templates",
        "apps/*/templates/cotton"
    ]
}
```

`templatePaths` accepts plain directories as well as glob patterns. Default: `["templates/cotton"]`

Alternatively, drop a `cotton.config.json` in your workspace root:

```json
{
    "templatePaths": ["templates/cotton"]
}
```

Settings are resolved with the following priority: VS Code settings > editor-agnostic LSP `initializationOptions` (for other editors) > `cotton.config.json` > built-in default.

## Requirements

- VS Code 1.85.0+
- Django project using Cotton templates

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for the full release history.
