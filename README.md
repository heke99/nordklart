# Nordklart login/routing hotfix

Apply from the extracted patch directory:

```bash
./apply.sh /path/to/nordklart-main
```

The script removes obsolete route files before copying the patched files. This
is required because simply copying files would leave the old `[sessionId]`
BankID route and cause a fatal Next.js dynamic-route conflict.
