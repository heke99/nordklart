#!/usr/bin/env bash
set -euo pipefail

# Run this script from inside the extracted hotfix folder and pass the target
# Nordklart project directory as the first argument. Defaults to current dir.
PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-$PWD}"
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

# Remove routes moved by the hotfix. Leaving these behind causes Next.js's
# fatal "different slug names for the same dynamic path" error.
rm -f "$TARGET_DIR/app/(dashboard)/page.tsx"
rm -rf "$TARGET_DIR/app/api/bankid/consents/[sessionId]"

rsync -a \
  --exclude 'apply.sh' \
  --exclude 'README.md' \
  "$PATCH_DIR/" "$TARGET_DIR/"

echo "Nordklart login/routing hotfix applied to: $TARGET_DIR"
