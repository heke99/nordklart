# Synkkommandon

Exempel när zippen ligger i `~/Downloads` och projektet i
`~/Projects/nordklart`:

```bash
PATCH_DIR="$(mktemp -d)"
unzip -oq ~/Downloads/nordklart-canonical-year-end-2026-07-30.zip -d "$PATCH_DIR"
rsync -a --exclude 'nordklart-canonical-year-end.patch' \
  "$PATCH_DIR"/ ~/Projects/nordklart/
cd ~/Projects/nordklart
npm ci
NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck
npm test
npm run db:migrate
```

Ta databasbackup och kör migrationen i staging före produktion.
