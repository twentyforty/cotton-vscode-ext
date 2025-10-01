# Django Cotton VS Code Extension

Comprehensive VS Code support for [Django Cotton](https://django-cotton.com/) templates.

## Features

- **Go to Definition** - Navigate to Cotton component templates
- **Component Autocompletion** - Smart suggestions for available components  
- **Parameter Intellisense** - Autocomplete component parameters from `<c-vars>`
- **Error Detection** - Highlight missing component files
- **Index.html Support** - Full support for Django Cotton's folder structure patterns

## Usage

### Go to Definition
Command/Ctrl+click any Cotton tag (e.g., `<c-ui.forms.input>`) to navigate to its template file.

### Component Autocompletion
Type `<c-` to see available components. Continue typing to filter (e.g., `<c-form`).

### Parameter Autocompletion
Inside Cotton component tags, get intelligent suggestions for component parameters:

```html
<!-- In your component file: -->
<c-vars title="Default" :count="0" disabled />

<!-- When using the component: -->
<c-my-component |  <!-- Cursor here - shows: title, :title, count, :count, etc. -->
```

## Configuration

```json
{
    "djangoCotton.templatePaths": [
        "templates/cotton",
        "other/templates"
    ]
}
```

Default: `["templates/cotton"]`

## Requirements

- VS Code 1.85.0+
- Django project using Cotton templates

## Release Notes

### 0.2.0
- **🏷️ C-Vars Parameter Intellisense**: Autocomplete component parameters from `<c-vars>` definitions
- **🔍 Error Detection**: Red squiggles for missing Cotton component files
- **📁 Index.html Support**: Full support for Django Cotton's index.html pattern

### 0.1.4
- Updated README to reflect new features

### 0.1.1
- Added component autocompletion
- Added template documentation support

### 0.1.0
- Initial release with Go to Definition support