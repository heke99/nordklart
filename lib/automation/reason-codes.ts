// Swedish translations for every reason/blocking code the bank automation
// engine emits (lib/automation/bank-transaction-automation.ts). Shared by the
// transactions UI, the pending-operations UI and the assistant's
// nordklart_explain_transaction_match tool so all surfaces explain automation
// decisions with the same wording. Unknown codes pass through verbatim so new
// engine codes degrade gracefully instead of crashing a surface.

export const REASON_CODE_SV: Record<string, string> = {
  // candidate signals
  own_account_transfer_detected:
    'Transaktionen ser ut som en överföring mellan företagets egna konton',
  bank_fee_pattern: 'Texten och beloppet matchar mönstret för en bankavgift',
  tax_payment_pattern: 'Mottagaren matchar Skatteverkets bankgiro (skattekontobetalning)',
  mapping_rule_match: 'En egen bokföringsregel matchade transaktionen',
  booking_template_match: 'En bokningsmall matchade transaktionen',
  counterparty_template_match: 'Motparten har bokförts tidigare — historiken gav ett förslag',
  no_confident_mapping: 'Ingen regel eller historik gav en tillräckligt säker kontering',
  mapping_requires_review: 'Konteringsförslaget kräver manuell granskning (t.ex. oklar moms)',
  exact_amount: 'Beloppet stämmer exakt med fakturans restbelopp',
  partial_or_over_payment: 'Beloppet avviker från fakturans restbelopp (del- eller överbetalning)',
  cross_currency: 'Transaktionen och fakturan har olika valutor',
  already_linked: 'Transaktionen är redan kopplad till en verifikation',
  auto_guards_passed: 'Alla säkerhetsspärrar passerade',
  // blocking guards
  after_sync_mode_blocks_auto:
    'Företagets automationsläge tillåter inte automatisk bokföring efter synk',
  below_auto_confidence: 'Träffsäkerheten låg under företagets tröskel för automatisk bokföring',
  ambiguous_candidates:
    'Flera kandidater låg för nära varandra i poäng — automatiken vägrar gissa',
  amount_over_auto_cap: 'Beloppet överstiger företagets maxgräns för automatisk bokföring',
  invoice_auto_settlement_disabled:
    'Automatisk avräkning av kundfakturor är avstängd i inställningarna',
  not_exact_payment: 'Betalningen är inte exakt lika med fakturabeloppet',
  invoice_disputed: 'Fakturan är markerad som bestriden',
  supplier_auto_link_disabled: 'Automatisk leverantörsavräkning är avstängd i inställningarna',
  bank_fee_auto_disabled: 'Automatisk bokföring av bankavgifter är avstängd',
  bank_fee_amount_unsafe: 'Beloppet är för stort för att säkert vara en bankavgift',
  vat_treatment_unclear: 'Momsbehandlingen är oklar — kräver manuellt val',
  bank_mode_blocks_auto: 'Bankautomationens läge tillåter inte automatisk bokföring',
  fx_transfer_requires_review: 'Valutaöverföring kräver manuell granskning',
  tax_payment_auto_disabled: 'Automatisk bokföring av skattebetalningar är avstängd',
  salary_auto_disabled: 'Automatisk lönekoppling är avstängd',
  category_auto_disabled: 'Automatisk kategoribokning är avstängd',
  no_actionable_candidate: 'Ingen kandidat var tillräckligt konkret för att agera på',
  sie_import_overlap:
    'En SIE-import täcker samma period — auto-bokföring spärrad för att undvika dubbelbokning',
  period_locked: 'Bokföringsperioden är låst',
  period_closed: 'Bokföringsperioden är stängd',
  period_status_unknown: 'Periodens status kunde inte fastställas — automatiken avstod',
  decision_claim_failed:
    'Beslutet kunde inte registreras i granskningsloggen — automatiken avstod av säkerhetsskäl',
  idempotent_replay: 'Transaktionen har redan utvärderats — inget gjordes om',
}

export interface TranslatedReasonCode {
  code: string
  explanation_sv: string
}

export function translateReasonCodes(codes: string[]): TranslatedReasonCode[] {
  return codes.map((code) => ({
    code,
    explanation_sv: REASON_CODE_SV[code] ?? code,
  }))
}
