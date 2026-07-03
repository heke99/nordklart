export const COOKBOOK_INVOICE_FINANCING_MD = `# Cookbook — offer an invoice for financing (fakturafinansiering)

> Check eligibility, submit a financing application for a sent customer invoice, accept the offer, and understand the payout bookkeeping — end to end against the sandbox provider.

Invoice financing lets a company sell (non-recourse) or borrow against (recourse) a sent, unpaid customer invoice. Nordklart validates eligibility, talks to the financing provider, and books the payout automatically when an offer is accepted.

> **Production requires an external agreement** with a financing partner. The sandbox provider (\`INVOICE_FINANCING_PROVIDER=sandbox\`, default outside production) answers synchronously with a deterministic 3 % fee so the whole flow can be integrated and tested without one.

## What you'll need

- An API key with \`financing:write\` scope (\`financing:read\` for listing).
- A **sent, fully unpaid invoice in SEK** to a business customer (B2B) whose customer record has an organisationsnummer.
- No ROT/RUT deduction on the invoice, amount within the provider's min/max, due date at most 90 days out and not more than 30 days overdue.

## 1. Create the application

\`\`\`bash
curl "https://app.nordklart.se/api/v1/companies/$COMPANY_ID/invoice-financing/applications" \\
  -H "Authorization: Bearer nordklart_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{ "invoice_id": "'$INVOICE_ID'", "recourse": false }'
\`\`\`

The sandbox answers synchronously. Response (\`201\`):

\`\`\`json
{
  "data": {
    "application": { "id": "f1a2...", "status": "offer_created", "recourse": false },
    "offer": {
      "id": "o1b2...",
      "offered_amount": 12500,
      "fee_percent": 3,
      "fee_amount": 375,
      "payout_amount": 12125,
      "valid_until": "2026-07-17T00:00:00Z"
    },
    "message_sv": "Erbjudande skapat: utbetalning 12 125 kr (avgift 375 kr)."
  },
  "meta": { "request_id": "req_...", "api_version": "2026-05-12" }
}
\`\`\`

**Eligibility failures return \`VALIDATION_ERROR\` with per-rule issues** so you can show the user exactly what to fix:

\`\`\`json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "details": {
      "issues": [
        { "code": "CUSTOMER_ORG_MISSING", "message": "Kundens organisationsnummer saknas — komplettera kundkortet (krävs för kreditprövning)." },
        { "code": "CURRENCY", "message": "Endast fakturor i SEK kan finansieras." }
      ]
    }
  }
}
\`\`\`

A second live application for the same invoice returns \`CONFLICT\` — cancel or settle the first one before retrying.

## 2. Accept the offer (payout + booking)

\`\`\`bash
curl -X POST "https://app.nordklart.se/api/v1/companies/$COMPANY_ID/invoice-financing/applications/$APP_ID/accept" \\
  -H "Authorization: Bearer nordklart_sk_test_..."
\`\`\`

On acceptance the provider pays out and Nordklart books the payout in the same call:

- **Non-recourse (sale):** Dr 1930 Företagskonto (payout) + Dr 6064 Factoringavgifter (fee) / Cr 1510 Kundfordringar (full invoice amount).
- **Recourse (borrowing):** reclass Dr 1512 Belånade kundfordringar / Cr 1510, then Dr 1930 + Dr 6064 / Cr 2330 Factoringkredit.
- **VAT is untouched** — the fee is an exempt financial service and the invoice's output VAT was reported at issue.

Response includes \`journal_entry_id\` (or a Swedish warning when no open fiscal period covers the payout date — the financing still advances; book manually).

## 3. Track the trail

\`\`\`bash
curl "https://app.nordklart.se/api/v1/companies/$COMPANY_ID/invoice-financing/applications/$APP_ID" \\
  -H "Authorization: Bearer nordklart_sk_test_..."
\`\`\`

Returns the application with its **offers**, an **append-only event trail** (every status transition, audit-grade) and **settlements** (payout amount, fee, journal entry).

## 4. Webhooks

Subscribe to the two financing events to react without polling:

- \`invoice_financing.offer_created\` — an offer is ready for acceptance (also emitted when a production provider answers asynchronously via the provider webhook).
- \`invoice_financing.paid_out\` — the payout is done and booked.

## Status model

\`submitted → offer_created → accepted → paid_out → settled\`, with \`needs_more_info\`, \`rejected\`, \`recourse\` and \`cancelled\` as branches. \`rejected\`, \`cancelled\` and \`settled\` are terminal — a new application can then be created for the same invoice.

## Sandbox test levers

- Customer org number ending in \`00\` → \`needs_more_info\`.
- Customer name containing \`avslag\` → \`rejected\`.
- Everything else → immediate offer at 3 % fee, valid 14 days.
`
