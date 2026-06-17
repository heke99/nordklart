#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-.}"
cd "$ROOT"
rm -f 'app/(dashboard)/bankgiro/page.tsx'
mkdir -p 'app/(dashboard)/payments/bankgiro'
# Run this script after unzipping this hotfix in the project root.
echo "Removed app/(dashboard)/bankgiro/page.tsx. Dashboard Bankgiro now uses /payments/bankgiro."
