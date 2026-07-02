import { defineAgentIntent } from './types'
import { SONNET_MODEL, THINKING_BUDGET_STANDARD } from '@/lib/agent/composer/client'
import { renderAgentGroundRules } from './shared-rules'

// general.help — always-present "Fråga min assistent" from the top nav.
//
// Atom mode is progressive: only the agent_atom_registry metadata lands in
// the system prompt (~200 tokens per atom), and the agent calls
// nordklart_load_skill on demand when a topic actually requires depth. This
// keeps TTFT low for the common "quick question" pattern without forcing
// the entire skill library into every chat turn.
//
// Plan refs: §8 (intent system, V1 #3), §10 (caching strategy — progressive
// disclosure keeps Block 1 small enough that cache reuse pays off across
// users).

interface GeneralHelpArgs {
  // Currently routed only with the URL the user is on. We don't capture page
  // contents — the chat sheet sits over the page and is intentionally
  // page-agnostic so the user can keep working underneath.
  route?: string
}

interface GeneralHelpCaptured {
  route: string | null
}

export const generalHelp = defineAgentIntent<GeneralHelpArgs, GeneralHelpCaptured>({
  id: 'general.help',
  buttonLabel: 'Fråga min assistent',
  sheetTitle: 'Fråga din assistent',

  atoms: {
    mode: 'progressive',
    horizontal: [],
    includeCompanyVertical: false,
    includeCompanyModifiers: false,
  },

  // general.help is the broad chat assistant — used both from the floating
  // pill on random pages AND from the /chat surface. Users land here with
  // analytical questions ("vad är min största utgiftspost?", "vilka
  // leverantörer skulder jag mest?", "hur ser min momsrapport ut?") that
  // require actually reading bookkeeping data, not just regulatory atoms.
  //
  // Tool whitelist is therefore comprehensive on the READ side. Write tools
  // (categorize, create_invoice, approve_supplier_invoice, stage_year_end,
  // …) deliberately stay out — those belong to the page-specific intents
  // where the agent has a single entity in focus and the user expects a
  // staged ApprovalCard. From /chat the agent redirects users to the right
  // page for write actions instead of trying to do them inline.
  //
  // Anthropic caches the tools list with the system prompt so a stable
  // whitelist costs nothing per turn after first warm-up.
  tools: [
    // Knowledge + memory. FAQ first: nordklart_faq_search hits the curated
    // 450-entry Swedish knowledge base before any skill atom is loaded.
    'nordklart_faq_search',
    'nordklart_search_tools',
    'nordklart_list_skills',
    'nordklart_load_skill',
    'nordklart_remember_fact',
    'nordklart_forget_fact',
    // Reports (the canonical analytical surface)
    'nordklart_get_income_statement',
    'nordklart_get_balance_sheet',
    'nordklart_get_trial_balance',
    'nordklart_get_general_ledger',
    'nordklart_get_kpi_report',
    'nordklart_get_vat_report',
    'nordklart_vat_close_check',
    'nordklart_get_ar_ledger',
    'nordklart_get_supplier_ledger',
    'nordklart_get_reconciliation_status',
    'nordklart_get_salary_journal',
    'nordklart_year_end_readiness',
    // Lookups across the working set
    'nordklart_query_journal',
    'nordklart_list_uncategorized_transactions',
    'nordklart_list_transactions_without_documents',
    'nordklart_list_invoices',
    'nordklart_list_customers',
    'nordklart_list_suppliers',
    'nordklart_list_supplier_invoices',
    'nordklart_list_accounts',
    'nordklart_list_fiscal_periods',
    'nordklart_list_employees',
    'nordklart_list_inbox_items',
    'nordklart_list_unmatched_documents',
    'nordklart_list_voucher_gaps',
    'nordklart_explain_voucher_gap',
    'nordklart_explain_transaction_match',
    'nordklart_get_inbox_item',
    'nordklart_get_document_content',
    'nordklart_get_counterparty_templates',
  ],

  model: SONNET_MODEL,

  // Reason before answering — this is the broad chat surface where the agent
  // answered regulatory questions from memory and narrated its steps. Thinking
  // moves the reasoning into its own channel so the visible reply is a single
  // consolidated answer.
  thinking: { budgetTokens: THINKING_BUDGET_STANDARD },

  capture: async ({ route }) => ({ route: route ?? null }),

  promptTemplate: ({ captured, profileSummary }) => {
    const lines: string[] = []
    if (profileSummary) {
      lines.push(`Företagets profil: ${profileSummary}`)
      lines.push('')
    }
    if (captured.route) {
      lines.push(`Användaren befinner sig på sidan: ${captured.route}`)
      lines.push('')
    }
    lines.push('Användaren öppnade ditt fönster med "Fråga min assistent". Inget specifikt ärende ännu.')
    lines.push('')
    lines.push(renderAgentGroundRules())
    lines.push('')
    lines.push('SÖKORDNING FÖR KUNSKAPSFRÅGOR: För produkt- och hur-gör-jag-frågor ("hur kopplar jag banken?", "varför matchades inte transaktionen?", "hur skickar jag AGI?") — anropa ALLTID nordklart_faq_search FÖRST. FAQ:n innehåller 450 kurerade svenska svar om Nordklarts arbetsflöden och vanliga regelfrågor. Träff med hög säkerhet: svara utifrån FAQ-svaret och nämn relaterad vy. Låg säkerhet eller ingen träff: gå vidare till skill-atomerna (nordklart_load_skill). Hitta aldrig på ett svar när båda källorna saknar underlag — säg det ärligt.')
    lines.push('')
    lines.push('Härifrån kan du (använd verktygen — citera siffrorna):')
    lines.push('- LÄSA bolagets data: resultatrapport, balansrapport, KPI:er, momsrapport, huvudbok, kund-/leverantörsreskontra, lönejournal, transaktioner, fakturor, kunder, leverantörer, kontoplan, dokumentinkorg, verifikationsluckor. När användaren frågar något analytiskt — anropa rätt verktyg och svara med faktiska siffror, inte uppskattningar.')
    lines.push('- Svara på regelfrågor: bokföring, moms, lön, bokslut, deklaration. Ladda atominnehåll med nordklart_load_skill vid behov.')
    lines.push('- Söka i journalen efter motpart, beskrivning eller belopp via nordklart_query_journal (t.ex. "har jag bokfört detta förut?").')
    lines.push('- Komma ihåg fakta om bolaget via nordklart_remember_fact / nordklart_forget_fact.')
    lines.push('')
    lines.push('Du har INGA skrivverktyg härifrån — du kan läsa och resonera, men inte kategorisera, fakturera, attestera eller stage:a bokslut, och du ska INTE låtsas att du kan.')
    lines.push('')
    lines.push('KATEGORISERING / BOKFÖRING — så här hanterar du det (vanligaste fallet): Om användaren ber dig kategorisera, bokföra eller "gå igenom" okategoriserade transaktioner, ge då INTE per-transaktions-bokföringsförslag (konto/momsbehandling) i löptext, och fråga ALDRIG "godkänner du dessa?". Två skäl: (1) du ser inte det matchade underlaget (kvitto/faktura) per transaktion härifrån, så förslaget vilar på gissningar; (2) du kan inte stagea någon bokning — det blir en analys användaren inte kan agera på. Hänvisa istället tydligt: "Själva kategoriseringen gör vi i Dokumentinkorgen: lägg kvittot/fakturan där (eller vidarebefordra det till företagets inbox-adress), matcha det mot transaktionen och fråga assistenten därifrån — då ser jag underlaget som hör till transaktionen och lägger ett förslag du godkänner direkt i kortet." Du FÅR ge en kort överblick (hur många som väntar, vilka de äldsta är, vilka som ser kluriga ut) för att hjälpa användaren prioritera — men stanna där, gå inte vidare till konto/moms per rad.')
    lines.push('')
    lines.push('Övriga skrivåtgärder hänvisas på samma sätt: fakturering → /invoices/new, leverantörsfaktura → /supplier-invoices/[id], moms → momsrapporten, bokslut → /bookkeeping/year-end. Där finns "Fråga …"-knappen med rätt skrivverktyg OCH rätt underlag inkopplat. Försök ALDRIG fabricera/föreslå att du stagear något härifrån.')
    lines.push('')
    lines.push('Bra rytm för analytiska frågor: (1) anropa rätt läsverktyg, (2) svara med konkreta siffror från resultatet, (3) lägg till en kort förklaring eller nästa-steg-rekommendation om det är meningsfullt. Hellre verkligt svar än "gå till Rapporter och titta själv".')
    lines.push('')
    lines.push('Vänta in användarens fråga. Hälsa kort och fråga vad du kan hjälpa till med. Var direkt — svaret du skriver nu är det första användaren ser.')
    return lines.join('\n')
  },
})
