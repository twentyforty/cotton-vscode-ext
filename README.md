# Cotton VS Code Extension

This VS Code extension provides Go to Definition support for [Django Cotton](https://django-cotton.com/) template tags. It allows you to Command/Ctrl+click on Cotton template tags to navigate directly to their template files.

## Features

- Go to Definition support for Cotton template tags (`<c-*>` and `</c-*>`)
- Supports template paths with both hyphens and underscores
- Works with multiple template directories

## Installation

1. Install the extension from the VS Code Marketplace
2. Open a project that uses Django Cotton
3. The extension will automatically activate for HTML and Django HTML files

## Usage

1. Place your cursor on any Cotton template tag (e.g., `<c-forms.input>`)
2. Hold Command (Mac) or Ctrl (Windows/Linux) and click the tag
3. VS Code will navigate to the corresponding template file

## Configuration

Configure template directories in your VS Code settings:

```json
{
    "djangoCotton.templatePaths": [
        "templates/cotton",
        "frontend/templates/cotton"
    ]
}
```

You can set this in:
- User Settings (applies globally)
- Workspace Settings (applies to the current workspace)
- Folder Settings (applies to a specific folder)

Default value if not configured:
```json
{
    "djangoCotton.templatePaths": ["templates/cotton"]
}
```

## Requirements

- VS Code 1.85.0 or higher
- A Django project using Cotton templates

## Extension Settings

This extension contributes the following settings:

* `djangoCotton.templatePaths`: Array of paths where Cotton templates are located (relative to workspace root)

## Known Issues

- The extension assumes Cotton tags follow the standard naming convention (`<c-*>`)

## Release Notes

### 0.1.0

Initial release:
- Go to Definition support for Cotton template tags
- Multi-directory support
- Hyphen/underscore path variations

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This extension is licensed under the MIT License.