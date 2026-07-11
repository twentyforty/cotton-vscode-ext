# Changelog

All notable changes to the Django Cotton VS Code extension are documented here.

## 1.0.0

A full rewrite of the extension onto a **Language Server Protocol (LSP)** architecture, plus a large batch of new navigation, completion, and validation features. This is a milestone release marking the extension's transition from a single-file, VS Code-only script to a proper client/server language tool.

### Architecture

- **Rewritten as a language server.** All Cotton-parsing intelligence now lives in an editor-agnostic language server (`src/server`), built on `vscode-languageserver` and `vscode-html-languageservice` for real AST-based HTML parsing (instead of regex-only scanning). The VS Code extension (`src/client`) is now a thin client that spawns the server and wires it into the editor.
- **No action required to upgrade.** Existing settings (`djangoCotton.templatePaths`) keep working unchanged; the extension behaves the same way out of the box, just with more features and better parsing accuracy.
- **New `cotton.config.json`.** Project-level configuration file, read from the workspace root, as an alternative to VS Code settings - useful for keeping Cotton config in source control or for other editors. Settings are resolved with priority: editor settings > LSP `initializationOptions` (for non-VS Code clients) > `cotton.config.json` > defaults.
- **Glob pattern support for template paths.** `djangoCotton.templatePaths` now accepts glob patterns in addition to plain directories, e.g. `"**/cotton"` or `"apps/*/templates/cotton"`.
- **Out-of-editor sync.** A workspace-wide file watcher keeps the extension's component and usage indexes accurate even when `.html` files change outside the editor (git checkout/pull, terminal, another tool).

### New features

- **Hover documentation.** Hovering a component tag shows its doc comment and full prop list (from `<c-vars>`); hovering a specific prop shows its default value and whether it can be passed as a boolean flag.
- **Find All References.** Standard "Find All References" (right-click or Shift+Alt+F12) works on a component usage, listing every place that component is used in the workspace. A new "Find Component Usages" command is also available from the Explorer context menu on a component file itself.
- **Unused component detection.** Component files with zero usages anywhere in the workspace are marked with a small "U" badge in the file explorer, so dead template files are easy to spot and clean up.
- **Go to Definition for props.** Cmd/Ctrl+click a prop at a component usage site (e.g. `title` in `<c-card title="...">`) to jump straight to its `<c-vars>` declaration, or to its first usage inside the component body if it's not declared in `<c-vars>`. Props that aren't tracked by the component at all (not declared, not referenced) no longer navigate anywhere.
- **Go to Definition for slot names.** Cmd/Ctrl+click a slot name in `<c-slot name="icon">` to jump to where the parent component consumes that slot (e.g. `{{ icon }}`), or its `<c-vars>` declaration.
- **`<c-component is="...">` support.** Dynamic component rendering is now understood end-to-end: go-to-definition on a static `is="button"` value jumps to that component, and a new diagnostic flags an `is` value that doesn't resolve to a real component. Dynamic (`:is="expr"`) values are left alone since they can't be resolved statically.
- **Autocomplete for built-in directives.** `<c-vars>`, `<c-slot>`, and `<c-component>` now show up in tag-name autocomplete alongside real components, each with their own attribute completions (`name` for `c-slot`; `is` / `:is` for `c-component`).
- **Named slot completion.** Inside `<c-slot name="...">`, autocomplete suggests candidate slot names based on variable references found in the target component's body.
- **Boolean attribute completion.** For a `<c-vars>` prop with no default value (commonly used as a boolean flag), autocomplete now also offers a valueless completion (e.g. `disabled`) alongside the usual `disabled="..."` and `:disabled="..."` variants.

### Fixes

- **Kebab-case/snake_case prop matching.** Go-to-definition and "used in body" detection for a prop like `icon-name` now correctly matches its snake_case form (`icon_name`) inside Django template expressions, matching Django Cotton's actual attribute-name conversion behavior.
- **Multi-line tags and improved end-tag detection**, carried forward and re-verified against the new AST-based parser.
- Attribute matching under the cursor no longer requires a leading `:` - plain prop names (e.g. `label`), single-colon dynamic props (`:count`), and escaped double-colon props (`::class`) all resolve correctly for hover and go-to-definition.

## 0.3.0 and earlier

See git history prior to this file for the original single-file extension's changelog (component autocompletion, `<c-vars>` parameter intellisense, missing-component error detection, `index.html` folder support, multi-line tag support).
