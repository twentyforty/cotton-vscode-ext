# Django Cotton VS Code Extension

Go to Definition and Autocompletion support for [Django Cotton](https://django-cotton.com/) template tags.

## Features

- **Go to Definition**: Command/Ctrl+click Cotton tags to navigate to their template files
- **Smart Autocompletion**: 
  - Triggers on `<c-`
  - Filters as you type
  - Adds closing tags automatically
  - Shows documentation from template comments

## Usage

### Go to Definition
Command/Ctrl+click any Cotton tag (e.g., `<c-forms.input>`) to navigate to its template.

### Autocompletion
Type `<c-` to see available components. Continue typing to filter (e.g., `<c-form`).

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

### 0.1.4
- Updated README to reflect new features

### 0.1.1
- Added component autocompletion
- Added template documentation support

### 0.1.0
- Initial release with Go to Definition support