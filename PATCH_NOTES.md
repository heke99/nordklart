# Nordklart — Year-end tax declaration completion patch

This patch implements the production foundation for:

- period-bound year-end access through subscription, one-time purchase, Complimentary Full Access, or platform admin bypass
- route-level protection for bokslut, årsredovisning, INK2, NE and declaration exports
- durable tax declaration project storage, adjustments, questionnaire answers, warnings, exports and audit events
- extended INK2S fields with approved tax adjustments
- declaration readiness/blockers and SRU preflight validation
- SRU ZIP export audit for INK2 and NE draft exports
- missing EF declaration preview route

Run the SQL migration first:

```bash
supabase/migrations/20260702120000_year_end_tax_declaration_completion.sql
```

Then run:

```bash
npm install
npm run build
```

Validation performed in sandbox:

- `npx eslint` on all changed TS/TSX route/library files: passed.
- Focused `tsc` patch check ran; it reported existing baseline errors in `lib/currency/riksbanken.ts` around Next `fetch(..., { next })` typing, not errors from the changed files.
- Full `next build` started but exceeded sandbox timeout before completion.

Important product note:

INK2/AB is now wired as a completion-ready flow with blockers. NE/enskild firma remains production-safe but intentionally blocked from being treated as complete until the full EF R12-R48 questionnaire/tax logic is added; draft SRU can be exported only with `allow_draft=1`.
