# Nordklart OpenDataLoader OCR Worker

Railway service for Nordklart document OCR. The Next.js app sends PDF/image bytes to this worker with an HMAC signature. The worker runs OpenDataLoader locally and returns text, Markdown and JSON.

## Railway setup

Create a new Railway service from the same GitHub repository and set the service root directory to:

```text
workers/opendataloader-ocr
```

Railway will use the Dockerfile in that directory. Set these variables on the worker service:

```env
OCR_SERVICE_HMAC_SECRET=<same secret as Nordklart app>
OCR_MAX_FILE_MB=10
PORT=8080
```

Set these variables on the Nordklart/Vercel app:

```env
OCR_SERVICE_URL=https://<railway-service-domain>
OCR_SERVICE_HMAC_SECRET=<same secret as worker>
OCR_DEFAULT_LANG=sv,en
OCR_REQUEST_TIMEOUT_MS=45000
OCR_MAX_FILE_MB=10
```

Health check:

```bash
curl https://<railway-service-domain>/healthz
```

## Notes

- Do not expose this service without `OCR_SERVICE_HMAC_SECRET`.
- The worker supports `application/pdf`, `image/jpeg`, `image/png`, `image/webp` and first-frame `image/gif`.
- Images are converted to one-page PDFs before OpenDataLoader runs.
