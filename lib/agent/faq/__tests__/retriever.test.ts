import { describe, it, expect } from 'vitest'
import {
  searchFaqEntries,
  retrieveFaq,
  normalizeSwedishText,
  tokenizeSwedish,
  FAQ_LOW_CONFIDENCE_THRESHOLD,
} from '../retriever'

// Batch 10 retrieval acceptance: at least 50 representative Swedish questions
// must surface the right FAQ entry, an unrelated question must fall back with
// low confidence, and high-risk answers must carry escalation.

describe('normalizeSwedishText / tokenizeSwedish', () => {
  it('lowercases, strips punctuation and keeps å/ä/ö', () => {
    expect(normalizeSwedishText('Hur BOKFÖR jag Löner?!')).toBe('hur bokför jag löner')
  })

  it('drops stopwords and stems light inflections', () => {
    const tokens = tokenizeSwedish('Hur bokför jag fakturan till kunden?')
    expect(tokens).not.toContain('hur')
    expect(tokens).not.toContain('jag')
    expect(tokens).not.toContain('till')
    // "fakturan" and "kunden" stem to their bases.
    expect(tokens.some((t) => t.startsWith('faktur'))).toBe(true)
    expect(tokens.some((t) => t.startsWith('kund'))).toBe(true)
  })
})

// Representative questions — deliberately paraphrased (not verbatim variants)
// so the test exercises normalization + stemming + field weighting, not string
// equality. Expected entry must appear in the top 3.
const RETRIEVAL_CASES: Array<[string, string]> = [
  // Kom igång & onboarding
  ['starta ett nytt bolag i systemet', 'onboarding-001'],
  ['vilken kontoplan används i Nordklart', 'onboarding-004'],
  ['skillnad mellan fakturametoden och kontantmetoden', 'onboarding-006'],
  ['bjuda in min kollega till företaget', 'onboarding-016'],
  ['finns det en app till mobilen', 'onboarding-020'],
  ['vad betyder väntande åtgärder', 'onboarding-034'],
  // Bankkoppling & transaktioner
  ['ansluta mitt bankkonto via PSD2', 'bank-001'],
  ['hur ofta synkas banken', 'bank-002'],
  ['bankmedgivandet har gått ut', 'bank-003'],
  ['importera kontoutdrag som fil', 'bank-005'],
  ['varför matchades inte transaktionen mot fakturan', 'bank-008'],
  ['bokföra överföring mellan mina egna konton', 'bank-011'],
  ['hur bokförs bankavgifter', 'bank-012'],
  ['kunden betalade bara halva fakturan', 'bank-028'],
  ['kunden betalade för mycket på fakturan', 'bank-029'],
  ['stödjer ni CAMT.053', 'bank-039'],
  ['maxgräns för automatisk bokföring', 'bank-024'],
  ['hur gör jag bankavstämning', 'bank-018'],
  // Bokföring, verifikationer & BAS-konton
  ['skapa en manuell verifikation', 'bokforing-001'],
  ['vad är storno', 'bokforing-003'],
  ['vilket BAS-konto ska jag använda', 'bokforing-006'],
  ['hur bokför jag importmoms', 'bokforing-018'],
  ['köpt molntjänst från utlandet hur bokförs momsen', 'bokforing-020'],
  ['moms vid export utanför EU', 'bokforing-023'],
  ['hur bokför jag ett banklån', 'bokforing-035'],
  ['hur bokför jag billeasing', 'bokforing-043'],
  ['skillnad mellan befarad och konstaterad kundförlust', 'bokforing-050'],
  // Moms
  ['vilka momssatser finns i Sverige', 'moms-001'],
  ['när ska momsen deklareras', 'moms-004'],
  ['vad är periodisk sammanställning', 'moms-007'],
  ['kontrollera kundens VAT-nummer', 'moms-006'],
  ['är det moms på lokalhyra', 'moms-016'],
  ['vad är trepartshandel', 'moms-029'],
  ['vad är vinstmarginalbeskattning', 'moms-039'],
  ['sälja varor till privatpersoner i EU moms', 'moms-042'],
  // Fakturering
  ['skapa en ny kundfaktura', 'faktura-001'],
  ['vad måste stå på en faktura', 'faktura-003'],
  ['hur gör jag en kreditfaktura', 'faktura-011'],
  ['hur mycket dröjsmålsränta får jag ta', 'faktura-013'],
  ['fakturera med ROT-avdrag', 'faktura-016'],
  ['schemalägga återkommande fakturor', 'faktura-017'],
  ['skicka e-faktura via Peppol', 'faktura-022'],
  ['skriva av en faktura som aldrig betalas', 'faktura-024'],
  // Leverantörsfakturor
  ['ladda upp en leverantörsfaktura', 'lev-001'],
  ['dubblett av leverantörsfaktura upptäcks', 'lev-006'],
  ['faktura från Google utan moms', 'lev-016'],
  ['representationskvitto momsavdrag lunch', 'lev-019'],
  // Lön
  ['skapa en lönekörning', 'lon-001'],
  ['hur mycket är arbetsgivaravgifterna', 'lon-003'],
  ['när ska AGI lämnas in', 'lon-008'],
  ['vad är skattekontot', 'lon-023'],
  ['vad är växa-stöd', 'lon-031'],
  // Bokslut
  ['när ska årsredovisningen lämnas in', 'bokslut-004'],
  ['vad är en periodiseringsfond', 'bokslut-016'],
  ['vad är INK2', 'bokslut-027'],
  ['hur genererar jag SRU-filer', 'bokslut-030'],
  ['vad är NE-bilagan', 'bokslut-038'],
  // Import/export, SIE, API & webhooks
  ['importera en SIE-fil', 'import-001'],
  ['ångra en SIE-import', 'import-010'],
  ['skapa en API-nyckel', 'import-021'],
  ['sätta upp webhooks', 'import-025'],
  // Byrå, plattform, behörigheter & säkerhet
  ['vad är Complimentary Full Access', 'byra-017'],
  ['radera mitt användarkonto enligt GDPR', 'byra-026'],
  ['vad loggas i audit-loggen', 'byra-020'],
  // Felsökning
  ['verifikationen balanserar inte', 'fel-002'],
  ['sidan laddar inte eller visar gammal data', 'fel-015'],
]

describe('searchFaqEntries — representative Swedish questions', () => {
  it(`covers at least 50 representative questions`, () => {
    expect(RETRIEVAL_CASES.length).toBeGreaterThanOrEqual(50)
  })

  for (const [query, expectedId] of RETRIEVAL_CASES) {
    it(`"${query}" → ${expectedId} in top 3`, () => {
      const matches = searchFaqEntries(query, { limit: 3 })
      const ids = matches.map((m) => m.entry.id)
      expect(ids, `got: ${ids.join(', ')}`).toContain(expectedId)
    })
  }

  it('exact question variant returns confidence 1.0 at rank 1', () => {
    const matches = searchFaqEntries('Hur kopplar jag banken?')
    expect(matches[0]?.entry.id).toBe('bank-001')
    expect(matches[0]?.confidence).toBe(1.0)
    expect(matches[0]?.matchedOn).toContain('question_exact')
  })

  it('confidence is bounded to [0, 1] and sorted descending', () => {
    const matches = searchFaqEntries('hur bokför jag lön och moms', { limit: 10 })
    expect(matches.length).toBeGreaterThan(0)
    for (let i = 0; i < matches.length; i++) {
      expect(matches[i].confidence).toBeGreaterThan(0)
      expect(matches[i].confidence).toBeLessThanOrEqual(1)
      if (i > 0) {
        expect(matches[i].confidence).toBeLessThanOrEqual(matches[i - 1].confidence)
      }
    }
  })
})

describe('retrieveFaq — fallback and escalation behavior', () => {
  it('falls back with lowConfidence for an unrelated question', async () => {
    const result = await retrieveFaq('hur lagar jag pannkakor till frukost')
    expect(result.lowConfidence).toBe(true)
    expect(result.source).toBe('local')
    const best = result.matches[0]?.confidence ?? 0
    expect(best).toBeLessThan(FAQ_LOW_CONFIDENCE_THRESHOLD)
  })

  it('falls back with lowConfidence for gibberish', async () => {
    const result = await retrieveFaq('xyzzy quux blorp')
    expect(result.lowConfidence).toBe(true)
  })

  it('high-risk topic surfaces the escalation text on the matched entry', async () => {
    const result = await retrieveFaq('ska jag ta lön eller utdelning från mitt AB?')
    expect(result.lowConfidence).toBe(false)
    const top = result.matches[0]
    expect(top.entry.id).toBe('lon-028')
    expect(top.entry.risk_level).toBe('high')
    expect(top.entry.escalation).toBeTruthy()
  })

  it('does not lose local results when the RPC fails', async () => {
    const failingSupabase = {
      rpc: async () => {
        throw new Error('connection refused')
      },
    } as never
    const result = await retrieveFaq('hur kopplar jag banken?', {
      supabase: failingSupabase,
    })
    expect(result.matches[0]?.entry.id).toBe('bank-001')
    expect(result.source).toBe('local')
  })

  it('blends tsvector RPC rows when the RPC succeeds', async () => {
    const supabase = {
      rpc: async (_fn: string, _args: unknown) => ({
        data: [{ id: 'bank-001', rank: 0.9 }],
        error: null,
      }),
    } as never
    const result = await retrieveFaq('hur kopplar jag banken?', { supabase })
    expect(result.source).toBe('hybrid')
    const top = result.matches[0]
    expect(top.entry.id).toBe('bank-001')
    expect(top.matchedOn).toContain('tsvector')
  })

  it('empty query returns no matches and low confidence', async () => {
    const result = await retrieveFaq('   ')
    expect(result.matches).toHaveLength(0)
    expect(result.lowConfidence).toBe(true)
  })
})
