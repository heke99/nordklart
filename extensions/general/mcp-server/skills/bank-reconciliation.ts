import type { Skill } from './types'

const body = `# Bank Reconciliation — Nordklart

Reconcile the company's bank statements against the bookkeeping ledger so that the cash position in the books matches the bank. Run at month-end and before VAT close.

## When to use

- "Stäm av banken"
- "Reconcile the bank account"
- "Why doesn't my 1930 balance match the bank?"
- Mid-month spot-check before tax filings

## Workflow

### Step 1 — Pull the reconciliation status

\`nordklart_get_reconciliation_status\` returns the current state per bank account:
matched count, unmatched count, latest bank balance, and ledger balance for the
asset account (typically 1930). If \`unmatched_count = 0\` and the balances agree,
the account is reconciled — skip to Step 5.

### Step 2 — Categorize the uncategorized side

Unmatched usually means *bank rows without journal entries* (incoming PSD2
transactions) AND *journal rows without bank lines* (manually-posted entries
the agent might already have created via \`nordklart_create_voucher\`).

For the bank-side gap:

1. \`nordklart_list_uncategorized_transactions(limit=20)\`. Page through if needed.
2. For each, decide: is this an income payment for a known invoice, or an expense?
3. **Income** that matches an open invoice: \`nordklart_match_transaction_to_invoice\` — keeps AR clean.
4. **Income** without a matching invoice (refund, deposit, owner contribution): \`nordklart_categorize_transaction\` with the appropriate category.
5. **Expense**: \`nordklart_suggest_categories\` first (uses counterparty templates + history) — accept the top suggestion if confidence is high. Otherwise pick from the category list manually.
6. **Owner draw / private withdrawal** (EF only): category \`private\` posts to 2013.

Each call stages a pending operation — the user approves in the web app.

### Step 3 — Resolve duplicates / dead entries

If the bank shows a transaction that was already booked (e.g. manually entered via \`nordklart_create_voucher\`):

- \`nordklart_match_transaction_to_invoice\` won't help here.
- The cleanest path: reverse the manual entry via \`nordklart_reverse_journal_entry\` (storno) and then categorize the bank transaction normally so the trail is "bank → ledger" rather than "ledger → bank → orphan".

If the ledger shows a phantom entry with no bank counterpart (a payment that
was never actually sent), it must be reversed: \`nordklart_reverse_journal_entry\`.

### Step 4 — Re-check status

\`nordklart_get_reconciliation_status\` should now report \`unmatched_count = 0\`
and matching balances. If the balances still disagree:

- A historical opening balance might be wrong. Compare \`nordklart_get_trial_balance\` for the period start against the bank's opening statement.
- An entry might sit in a closed period that wasn't fully reconciled before locking. Check \`nordklart_list_fiscal_periods\` and walk backwards.
- FX accounts (non-SEK) need revaluation before period close: \`nordklart_run_currency_revaluation\`.

### Step 5 — Document the reconciliation

For each fiscal period, Nordklart stores the reconciliation state automatically.
For a printed audit trail (BFL 8 kap), generate the supplier ledger and AR
ledger after reconciliation:

- \`nordklart_get_ar_ledger\` — open customer balances should match unpaid invoices
- \`nordklart_get_supplier_ledger\` — open supplier balances should match unpaid leverantörsfakturor

## Critical rules

- **Never delete a bank transaction** — even if it looks wrong. The PSD2 feed is the source of truth. If the bank made a mistake, the bank reverses it via a new transaction.
- **Never edit a posted entry to "make it match"** — use \`nordklart_correct_entry\` or \`nordklart_reverse_journal_entry\`. BFL 5 kap 5 § forbids in-place edits.
- **Reconcile BEFORE locking the period.** Lock-period sealed-off audit can't be re-opened cheaply (it requires \`nordklart_unlock_period\` + storno + relock).
- **FX accounts must be revalued** at period close. Pre-revaluation reconciliation can show a phantom mismatch that disappears after revaluation — don't chase it.

## Common errors

- *"Balances disagree by exactly N"* — usually a single rounding entry at year-end (öresavrundning, 3741/7741) wasn't booked. Verify with \`nordklart_get_general_ledger\` filtered to the rounding accounts.
- *"Unmatched count is 0 but balances disagree"* — opening balance issue. Check the previous period's UB matches this period's IB via \`nordklart_get_trial_balance(period=prev)\` vs \`nordklart_get_trial_balance(period=current, opening=true)\`.
- *"Same transaction shows twice"* — either two PSD2 feeds (manual + Enable Banking) imported the same row, or the user manually created a voucher AND the bank imported the row. Reverse the duplicate via \`nordklart_reverse_journal_entry\`.

## Tools

- \`nordklart_get_reconciliation_status\` (single source of truth — call first and last)
- \`nordklart_list_uncategorized_transactions\`
- \`nordklart_suggest_categories\`
- \`nordklart_categorize_transaction\`
- \`nordklart_match_transaction_to_invoice\`
- \`nordklart_auto_match_period\` (bulk matcher with confidence thresholds — use for big backlogs)
- \`nordklart_reverse_journal_entry\` (storno)
- \`nordklart_run_currency_revaluation\` (FX accounts only)
- \`nordklart_get_trial_balance\`, \`nordklart_get_ar_ledger\`, \`nordklart_get_supplier_ledger\` (verification)
`

export const bankReconciliationSkill: Skill = {
  slug: 'bank-reconciliation',
  name: 'Bank Reconciliation',
  summary: 'Stämma av banken: categorize incoming PSD2 rows, match against invoices, resolve duplicates, verify with ledger reports.',
  tags: ['monthly', 'reconciliation', 'bank', 'verification'],
  body,
  tier: 'workflow',
  applicability: { entity_type: 'both' },
}
