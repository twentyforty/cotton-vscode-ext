#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/packages/vscode-extension"
STAGE="$(mktemp -d)"

cleanup() {
  rm -rf "$STAGE"
  rm -rf "$EXT/node_modules"
}
trap cleanup EXIT

echo "Compiling monorepo..."
cd "$ROOT"
npm run compile

echo "Staging extension for packaging..."
rsync -a \
  --exclude node_modules \
  --exclude '*.vsix' \
  "$EXT/" "$STAGE/"

echo "Installing production dependencies..."
cd "$STAGE"
npm install --omit=dev --ignore-scripts

echo "Packaging VSIX..."
npx @vscode/vsce package

VSIX="$(ls -1 "$STAGE"/*.vsix | head -1)"
cp "$VSIX" "$EXT/"
echo "Packaged: $EXT/$(basename "$VSIX")"

if [[ "${1:-}" == "--publish" ]]; then
  echo "Publishing to VS Code Marketplace..."
  npx @vscode/vsce publish -i "$VSIX"
else
  echo "To publish: npx @vscode/vsce publish -i $EXT/$(basename "$VSIX")"
fi
