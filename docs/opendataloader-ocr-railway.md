# OpenDataLoader OCR på Railway

Nordklart använder inte Claude, Anthropic eller AWS Bedrock i OCR-kedjan. Dokumentflödet är:

```text
Nordklart/Vercel → OpenDataLoader OCR Worker/Railway → Nordklart deterministic invoice parser → extracted_data
```

## Railway-service

Skapa en separat Railway-service från samma GitHub-repo.

Service root directory:

```text
workers/opendataloader-ocr
```

Railway använder `workers/opendataloader-ocr/Dockerfile`. Worker-exponeringen ska ligga bakom HMAC-signering; `/healthz` är enda öppna kontrollendpointen.

Worker variables:

```env
OCR_SERVICE_HMAC_SECRET=<starkt slumpat värde>
OCR_MAX_FILE_MB=10
PORT=8080
```

Nordklart/Vercel variables:

```env
OCR_SERVICE_URL=https://<railway-service-domain>
OCR_SERVICE_HMAC_SECRET=<samma värde som worker>
OCR_DEFAULT_LANG=sv,en
OCR_REQUEST_TIMEOUT_MS=45000
OCR_MAX_FILE_MB=10
```

## Säkerhet

Varje `POST /v1/ocr` signeras med:

```text
x-nordklart-timestamp
x-nordklart-signature = HMAC_SHA256(secret, timestamp + "." + rawBody)
```

Workern nekar request om signatur saknas, timestamp är för gammal eller filen är för stor.

## Databas

`document_ocr_runs` sparar rå OCR-output och status. `document_attachments.extracted_data` fortsätter att bara innehålla tolkade ekonomi-/fakturafält.

Statusar:

```text
queued, running, succeeded, failed, skipped
```

## Stöd i första versionen

- PDF
- JPEG
- PNG
- WebP
- första frame av GIF

HEIC/HEIF laddas fortfarande upp men OCR-skippas tills vi lägger till konvertering.
