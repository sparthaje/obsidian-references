#!/usr/bin/env bash
# Install the built Links plugin into an Obsidian vault.
# Usage: bash scripts/install-to-vault.sh "/path/to/YourVault"
set -euo pipefail

VAULT="${1:-}"
if [ -z "$VAULT" ]; then
  echo "Usage: bash scripts/install-to-vault.sh \"/path/to/YourVault\""
  exit 1
fi
if [ ! -d "$VAULT/.obsidian" ]; then
  echo "Error: '$VAULT' does not look like an Obsidian vault (no .obsidian folder)."
  exit 1
fi
if [ ! -f main.js ]; then
  echo "Error: main.js not found. Run 'npm run quick-build' first."
  exit 1
fi

DEST="$VAULT/.obsidian/plugins/references"
mkdir -p "$DEST"
cp main.js manifest.json "$DEST/"

# Remove the pre-rename folder if present, so it doesn't linger as a stale "Links" entry.
rm -rf "$VAULT/.obsidian/plugins/links"

# Wire up live rebuilds: 'npm run dev' will now output straight into the vault.
printf '%s' "$DEST" > .vault_plugin_dir

echo "Installed References -> $DEST"
echo "Enable it in Obsidian: Settings -> Community plugins -> References (reload Obsidian if it doesn't show)."
echo "Live dev: 'npm run dev' now rebuilds directly into the vault."
