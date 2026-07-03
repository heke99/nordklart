import faqData from '@/data/assistant/faq-sv.json'

// Typed access to the bundled 450-entry Swedish FAQ dataset
// (data/assistant/faq-sv.json). The JSON is statically imported so it ships
// in the server bundle on every deploy target (Vercel, Docker, self-hosted) —
// no filesystem reads, no DB dependency for the in-process retrieval path.
// The same dataset is seeded into assistant_faq_entries via the generated
// migration (npm run faq:generate) for the tsvector RPC path and the
// settings-UI status card.

export type FaqRiskLevel = 'low' | 'medium' | 'high'

export interface FaqEntry {
  id: string
  category: string
  intent: string
  user_questions: string[]
  short_answer_sv: string
  answer_sv: string
  sources: string[]
  required_permissions: string[]
  related_routes: string[]
  risk_level: FaqRiskLevel
  escalation: string | null
  updated_at: string
}

// The exact category distribution the dataset must satisfy. The original
// Batch 10 spec shipped 450 entries; the production-completion batches
// appended coverage for new modules (fakturafinansiering, betalfiler,
// BankID-samtycken, migrering Briox/BL, automationscentret, läsläge).
export const FAQ_CATEGORY_DISTRIBUTION: Record<string, number> = {
  'Kom igång & onboarding': 35,
  'Bankkoppling & transaktioner': 46,
  'Bokföring, verifikationer & BAS-konton': 55,
  'Moms, VAT & periodisk sammanställning': 55,
  'Fakturering, kundreskontra & Bankgiro': 48,
  'Leverantörsfakturor, kvitton & OCR': 36,
  'Lön, AGI & F-skatt': 40,
  'Bokslut, årsredovisning, INK2, NE & SRU': 55,
  'Import/export, SIE, API & webhooks': 37,
  'Byrå, plattform, behörigheter & säkerhet': 37,
  'Felsökning & vanliga fel': 16,
}

export const FAQ_TOTAL_ENTRIES = 460

const entries = faqData as FaqEntry[]

export function getFaqEntries(): FaqEntry[] {
  return entries
}

export function getFaqEntry(id: string): FaqEntry | undefined {
  return entries.find((e) => e.id === id)
}
