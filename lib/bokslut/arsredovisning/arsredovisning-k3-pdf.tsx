import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import type { ArsredovisningData } from './types'
import { formatAnnualReportAmount, normalizeAnnualReportText } from './format'

/**
 * K3 årsredovisning PDF template (BFNAR 2012:1).
 *
 * Layout extends the K2 template with two additional statements required
 * for K3:
 *   - Kassaflödesanalys (K3 ch.7)
 *   - Förändring av eget kapital (K3 ch.6 — separate statement, not a
 *     förvaltningsberättelse table).
 *
 * Page order:
 *   1. Cover
 *   2. Förvaltningsberättelse (+ flerårsöversikt + förslag till
 *      resultatdisposition)
 *   3. Resultaträkning
 *   4. Balansräkning
 *   5. Kassaflödesanalys
 *   6. Förändring av eget kapital
 *   7+ Noter (paginates automatically — the richer K3 note set rarely fits
 *      on one page so we let @react-pdf wrap)
 *   last. Underskrifter + Fastställelseintyg
 *
 * Styling intentionally matches arsredovisning-pdf.tsx so K2 and K3
 * documents are visually consistent for users that switch between them.
 */
const styles = StyleSheet.create({
  page: {
    paddingTop: 50,
    paddingHorizontal: 50,
    paddingBottom: 60,
    fontSize: 10,
    fontFamily: 'Helvetica',
  },
  pageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
    fontSize: 8,
    color: '#555',
    borderBottomWidth: 0.5,
    borderBottomColor: '#aaa',
    paddingBottom: 6,
  },
  pageFooter: {
    position: 'absolute',
    bottom: 30,
    left: 50,
    right: 50,
    fontSize: 8,
    color: '#888',
    textAlign: 'center',
  },
  title: {
    fontSize: 24,
    fontFamily: 'Helvetica-Bold',
    marginTop: 40,
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 12,
    color: '#444',
    marginBottom: 6,
  },
  k3Banner: {
    fontSize: 10,
    color: '#444',
    marginBottom: 50,
    paddingTop: 2,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    marginTop: 20,
    marginBottom: 10,
  },
  paragraph: {
    marginBottom: 8,
    lineHeight: 1.4,
  },
  noteBody: {
    marginBottom: 4,
    lineHeight: 1.4,
  },
  tableHeader: {
    flexDirection: 'row',
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    borderBottomWidth: 0.5,
    borderBottomColor: '#888',
    paddingBottom: 4,
    marginBottom: 4,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 2,
  },
  tableRowTotal: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderTopWidth: 0.5,
    borderTopColor: '#888',
    fontFamily: 'Helvetica-Bold',
  },
  tableRowSubtotal: {
    flexDirection: 'row',
    paddingVertical: 3,
    marginTop: 4,
    borderTopWidth: 0.5,
    borderTopColor: '#888',
    fontFamily: 'Helvetica-Bold',
  },
  colLabel: {
    flex: 1,
  },
  colLabelIndent: {
    flex: 1,
    paddingLeft: 12,
  },
  colAmount: {
    width: 100,
    textAlign: 'right',
  },
  signatureLine: {
    flexDirection: 'row',
    marginTop: 30,
    alignItems: 'flex-end',
  },
  signatureSlot: {
    flex: 1,
    marginRight: 20,
    borderBottomWidth: 0.5,
    borderBottomColor: '#333',
    paddingBottom: 2,
  },
  reconciliationBlock: {
    marginTop: 12,
    padding: 10,
    borderWidth: 0.5,
    borderColor: '#888',
  },
})

function fmt(amount: number): string {
  return formatAnnualReportAmount(amount, { decimals: 0 })
}

function clean(value: string | null | undefined): string {
  return normalizeAnnualReportText(value ?? '')
}

function PageChrome({
  data,
  pageLabel,
  isDraft = false,
}: {
  data: ArsredovisningData
  pageLabel?: string
  isDraft?: boolean
}) {
  return (
    <>
      {isDraft ? (
        <Text
          fixed
          style={{
            position: 'absolute',
            top: 320,
            left: 60,
            fontSize: 90,
            color: '#e5e7eb',
            transform: 'rotate(-30deg)',
            fontFamily: 'Helvetica-Bold',
          }}
        >
          UTKAST
        </Text>
      ) : null}
      <View style={styles.pageHeader} fixed>
        <Text>
          {data.company.name} · {data.company.org_number}
        </Text>
        <Text>
          Årsredovisning {data.fiscal_period.name}
          {isDraft ? ' - UTKAST' : ''}
        </Text>
      </View>
      <Text
        style={styles.pageFooter}
        fixed
        render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
          `${pageLabel ? `${clean(pageLabel)} · ` : ''}Sida ${pageNumber} av ${totalPages}`
        }
      />
    </>
  )
}

export function ArsredovisningK3PDF({
  data,
  isDraft = true,
  draftBlockers = [],
}: {
  data: ArsredovisningData
  /** R11: drafts carry a visible UTKAST watermark + blocker list. */
  isDraft?: boolean
  draftBlockers?: string[]
}) {
  const latestSignatureDate = data.signatures
    .map((signature) => signature.signed_at?.slice(0, 10) ?? null)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null

  return (
    <Document>
      {/* Cover */}
      <Page size="A4" style={styles.page}>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Försättssida" />
        <View>
          <Text style={styles.title}>Årsredovisning</Text>
          <Text style={styles.subtitle}>
            för räkenskapsåret {data.fiscal_period.period_start} - {data.fiscal_period.period_end}
          </Text>
          <Text style={styles.k3Banner}>Upprättad enligt K3 (BFNAR 2012:1)</Text>
          <Text style={styles.paragraph}>{data.company.name}</Text>
          <Text style={styles.paragraph}>Organisationsnummer: {data.company.org_number}</Text>
          {data.company.city && (
            <Text style={styles.paragraph}>Säte: {data.company.city}</Text>
          )}
        </View>
      </Page>

      {/* Förvaltningsberättelse */}
      <Page size="A4" style={styles.page}>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Förvaltningsberättelse" />
        <Text style={styles.sectionTitle}>Förvaltningsberättelse</Text>

        <Text style={styles.sectionTitle}>Verksamhet</Text>
        <Text style={styles.paragraph}>{data.forvaltningsberattelse.description}</Text>

        <Text style={styles.sectionTitle}>Väsentliga händelser under räkenskapsåret</Text>
        <Text style={styles.paragraph}>{data.forvaltningsberattelse.important_events}</Text>

        {data.forvaltningsberattelse.kontrollbalans_required && (
          <>
            <Text style={styles.sectionTitle}>Kontrollbalansräkning</Text>
            <Text style={styles.paragraph}>
              Kontrollbalansräkning har upprättats under räkenskapsåret enligt ABL 25 kap.
            </Text>
          </>
        )}

        <Text style={styles.sectionTitle}>Flerårsöversikt (kr)</Text>
        <View style={styles.tableHeader}>
          <Text style={styles.colLabel}>År</Text>
          <Text style={styles.colAmount}>Nettoomsättning</Text>
          <Text style={styles.colAmount}>Resultat e.fin.poster</Text>
          <Text style={styles.colAmount}>Soliditet (%)</Text>
        </View>
        {data.forvaltningsberattelse.flerarsoversikt.map((row) => (
          <View key={row.year} style={styles.tableRow}>
            <Text style={styles.colLabel}>{row.year}</Text>
            <Text style={styles.colAmount}>{row.data_missing ? 'Saknas' : fmt(row.net_revenue)}</Text>
            <Text style={styles.colAmount}>{row.data_missing ? 'Saknas' : fmt(row.result_after_financial)}</Text>
            <Text style={styles.colAmount}>
              {row.data_missing ? 'Saknas' : row.soliditet_pct === null ? '—' : row.soliditet_pct.toFixed(1)}
            </Text>
          </View>
        ))}

        <Text style={styles.sectionTitle}>Förslag till resultatdisposition</Text>
        <Text style={styles.paragraph}>{data.forvaltningsberattelse.resultatdisposition}</Text>
      </Page>

      {/* Resultaträkning */}
      <Page size="A4" style={styles.page}>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Resultaträkning" />
        <Text style={styles.sectionTitle}>Resultaträkning (kr)</Text>
        <View style={styles.tableHeader}>
          <Text style={styles.colLabel}>Post</Text>
          <Text style={styles.colAmount}>{data.fiscal_period.name}</Text>
          {data.prior_period ? (
            <Text style={styles.colAmount}>{data.prior_period.name}</Text>
          ) : null}
        </View>
        {data.resultatrakning.map((line, i) => (
          <View key={i} style={line.is_total ? styles.tableRowTotal : styles.tableRow}>
            <Text style={styles.colLabel}>{line.label}</Text>
            <Text style={styles.colAmount}>{fmt(line.amount)}</Text>
            {data.prior_period ? (
              <Text style={styles.colAmount}>
                {line.prior_amount != null ? fmt(line.prior_amount) : '—'}
              </Text>
            ) : null}
          </View>
        ))}
      </Page>

      {/* Balansräkning */}
      <Page size="A4" style={styles.page}>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Balansräkning" />
        <Text style={styles.sectionTitle}>Tillgångar (kr)</Text>
        <View style={styles.tableHeader}>
          <Text style={styles.colLabel}>Post</Text>
          <Text style={styles.colAmount}>{data.fiscal_period.period_end}</Text>
          {data.prior_period ? (
            <Text style={styles.colAmount}>{data.prior_period.name}</Text>
          ) : null}
        </View>
        {data.balansrakning.assets.map((line, i) => (
          <View key={i} style={line.is_total ? styles.tableRowTotal : styles.tableRow}>
            <Text style={line.indent ? styles.colLabelIndent : styles.colLabel}>
              {line.label}
            </Text>
            <Text style={styles.colAmount}>{fmt(line.amount)}</Text>
            {data.prior_period ? (
              <Text style={styles.colAmount}>
                {line.prior_amount != null ? fmt(line.prior_amount) : '—'}
              </Text>
            ) : null}
          </View>
        ))}
        <View style={styles.tableRowTotal}>
          <Text style={styles.colLabel}>Summa tillgångar</Text>
          <Text style={styles.colAmount}>{fmt(data.balansrakning.total_assets)}</Text>
          {data.prior_period ? (
            <Text style={styles.colAmount}>
              {data.balansrakning.total_assets_prior != null
                ? fmt(data.balansrakning.total_assets_prior)
                : '—'}
            </Text>
          ) : null}
        </View>

        <Text style={styles.sectionTitle}>Eget kapital och skulder (kr)</Text>
        {data.balansrakning.equity_liabilities.map((line, i) => (
          <View key={i} style={line.is_total ? styles.tableRowTotal : styles.tableRow}>
            <Text style={line.indent ? styles.colLabelIndent : styles.colLabel}>
              {line.label}
            </Text>
            <Text style={styles.colAmount}>{fmt(line.amount)}</Text>
            {data.prior_period ? (
              <Text style={styles.colAmount}>
                {line.prior_amount != null ? fmt(line.prior_amount) : '—'}
              </Text>
            ) : null}
          </View>
        ))}
        <View style={styles.tableRowTotal}>
          <Text style={styles.colLabel}>Summa eget kapital och skulder</Text>
          <Text style={styles.colAmount}>{fmt(data.balansrakning.total_equity_liabilities)}</Text>
          {data.prior_period ? (
            <Text style={styles.colAmount}>
              {data.balansrakning.total_equity_liabilities_prior != null
                ? fmt(data.balansrakning.total_equity_liabilities_prior)
                : '—'}
            </Text>
          ) : null}
        </View>
      </Page>

      {/* Kassaflödesanalys — K3 only. Rendered as a flat list of rows so the
          page is laid out consistently with the other statements in this
          template. */}
      {data.kassaflodesanalys && (
        <Page size="A4" style={styles.page}>
          <PageChrome data={data} isDraft={isDraft} pageLabel="Kassaflödesanalys" />
          <Text style={styles.sectionTitle}>Kassaflödesanalys (kr)</Text>
          <Text style={[styles.paragraph, { fontSize: 9, color: '#666' }]}>
            Indirekt metod enligt BFNAR 2012:1 kap 7.
          </Text>

          <Text style={styles.sectionTitle}>Den löpande verksamheten</Text>
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Resultat efter finansiella poster</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.lopande.resultat_efter_finansiella_poster)}
            </Text>
          </View>
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Justeringar för avskrivningar</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.lopande.avskrivningar)}
            </Text>
          </View>
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Övriga ej-kassaflödespåverkande poster</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.lopande.ovriga_ej_kassaflodesposter)}
            </Text>
          </View>
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Förändring av kortfristiga fordringar</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.lopande.delta_kortfristiga_fordringar)}
            </Text>
          </View>
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Förändring av varulager</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.lopande.delta_varulager)}
            </Text>
          </View>
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Förändring av kortfristiga skulder</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.lopande.delta_kortfristiga_skulder)}
            </Text>
          </View>
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Betald inkomstskatt</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.lopande.skatt_betald)}
            </Text>
          </View>
          <View style={styles.tableRowSubtotal}>
            <Text style={styles.colLabel}>Kassaflöde från den löpande verksamheten</Text>
            <Text style={styles.colAmount}>{fmt(data.kassaflodesanalys.lopande.total)}</Text>
          </View>

          <Text style={styles.sectionTitle}>Investeringsverksamheten</Text>
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Förvärv av anläggningstillgångar</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.investerings.forvarv_anlaggningar)}
            </Text>
          </View>
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Avyttring av anläggningstillgångar</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.investerings.avyttring_anlaggningar)}
            </Text>
          </View>
          <View style={styles.tableRowSubtotal}>
            <Text style={styles.colLabel}>Kassaflöde från investeringsverksamheten</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.investerings.total)}
            </Text>
          </View>

          <Text style={styles.sectionTitle}>Finansieringsverksamheten</Text>
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Förändring av lån (långfristiga skulder)</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.finansierings.delta_lan)}
            </Text>
          </View>
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Utdelningar till ägare</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.finansierings.utdelningar)}
            </Text>
          </View>
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Nyemission</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.finansierings.nyemission)}
            </Text>
          </View>
          <View style={styles.tableRowSubtotal}>
            <Text style={styles.colLabel}>Kassaflöde från finansieringsverksamheten</Text>
            <Text style={styles.colAmount}>
              {fmt(data.kassaflodesanalys.finansierings.total)}
            </Text>
          </View>

          <View style={styles.tableRowTotal}>
            <Text style={styles.colLabel}>Årets kassaflöde</Text>
            <Text style={styles.colAmount}>{fmt(data.kassaflodesanalys.total_cash_flow)}</Text>
          </View>

          <View style={styles.reconciliationBlock}>
            <Text style={{ fontFamily: 'Helvetica-Bold', marginBottom: 4 }}>
              Avstämning mot likvida medel (19xx)
            </Text>
            <View style={styles.tableRow}>
              <Text style={styles.colLabel}>Ingående saldo</Text>
              <Text style={styles.colAmount}>
                {fmt(data.kassaflodesanalys.reconciliation.opening_cash_1xxx)}
              </Text>
            </View>
            <View style={styles.tableRow}>
              <Text style={styles.colLabel}>Utgående saldo</Text>
              <Text style={styles.colAmount}>
                {fmt(data.kassaflodesanalys.reconciliation.closing_cash_1xxx)}
              </Text>
            </View>
            <View style={styles.tableRow}>
              <Text style={styles.colLabel}>Faktisk förändring</Text>
              <Text style={styles.colAmount}>
                {fmt(data.kassaflodesanalys.reconciliation.delta_actual)}
              </Text>
            </View>
            {!data.kassaflodesanalys.reconciliation.is_reconciled && (
              <View style={styles.tableRow}>
                <Text style={[styles.colLabel, { color: '#b91c1c' }]}>
                  Avvikelse — kontrollera bokföringen
                </Text>
                <Text style={[styles.colAmount, { color: '#b91c1c' }]}>
                  {fmt(data.kassaflodesanalys.reconciliation.mismatch_amount)}
                </Text>
              </View>
            )}
          </View>
        </Page>
      )}

      {/* Förändring av eget kapital — K3 separate statement */}
      {data.equity_changes_statement && (
        <Page size="A4" style={styles.page}>
          <PageChrome data={data} isDraft={isDraft} pageLabel="Förändring av eget kapital" />
          <Text style={styles.sectionTitle}>Förändring av eget kapital (kr)</Text>
          {data.equity_changes_statement.rows.map((row, i) => {
            // Heuristic: "Summa" rows are subtotals/totals; render them
            // with the totals style so the layout reads like a financial
            // statement.
            const isTotal = row.label.startsWith('Summa')
            return (
              <View
                key={i}
                style={isTotal ? styles.tableRowTotal : styles.tableRow}
              >
                <Text style={styles.colLabel}>{row.label}</Text>
                <Text style={styles.colAmount}>{fmt(row.amount)}</Text>
              </View>
            )
          })}
        </Page>
      )}

      {/* Noter */}
      <Page size="A4" style={styles.page} wrap>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Noter" />
        <Text style={styles.sectionTitle}>Noter</Text>
        {data.noter.map((note) => (
          <View key={note.number} style={{ marginBottom: 16 }} wrap>
            <Text style={{ fontFamily: 'Helvetica-Bold', marginBottom: 4 }}>
              Not {note.number} - {clean(note.title)}
            </Text>
            <Text style={styles.noteBody}>{clean(note.body)}</Text>
          </View>
        ))}
      </Page>

      {/* Underskrifter */}
      <Page size="A4" style={styles.page}>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Underskrifter" />
        <Text style={styles.sectionTitle}>Underskrifter</Text>
        <Text style={styles.paragraph}>
          {data.company.city ? `${data.company.city}, ` : ''}
          {latestSignatureDate ?? 'underskriftsdatum saknas'}
        </Text>
        {data.signatures.length > 0 ? (
          data.signatures.map((sig, i) => (
            <View key={i} style={styles.signatureLine}>
              <View style={styles.signatureSlot}>
                <Text>{sig.name || ' '}</Text>
              </View>
              <Text style={{ width: 180 }}>
                {clean(sig.role)}
                {sig.signed_at
                  ? ` - signerad ${sig.signed_at.slice(0, 10)}`
                  : ' - ej signerad'}
              </Text>
            </View>
          ))
        ) : (
          <Text style={styles.paragraph}>
            Inga undertecknare är registrerade. Registrera styrelseledamöter/VD
            innan dokumentet kan färdigställas.
          </Text>
        )}
      </Page>

      {/*
        Fastställelseintyg — mirrors the K2 template. K3 documents face the
        same Bolagsverket filing requirement (ÅRL 8 kap 3 §). Signer label
        remains "Styrelseledamot (närvarande vid stämman)".
      */}
      <Page size="A4" style={styles.page}>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Fastställelseintyg" />
        <Text style={styles.sectionTitle}>Fastställelseintyg</Text>
        <Text style={styles.paragraph}>
          Undertecknad styrelseledamot, närvarande vid årsstämman, intygar härmed
          att resultaträkningen och balansräkningen har fastställts på årsstämma
          den {data.forvaltningsberattelse.agm_date ?? '____________________'} och
          att årsstämman beslutade om disposition av bolagets resultat i enlighet
          med vad som anges nedan.
        </Text>
        <Text style={styles.paragraph}>
          Jag intygar också att årsredovisningen ger en rättvisande bild av
          företagets ställning och resultat samt att förvaltningsberättelsen ger
          en rättvisande översikt över utvecklingen av företagets verksamhet,
          ställning och resultat.
        </Text>
        <Text style={styles.sectionTitle}>Stämmans beslut om resultatdisposition</Text>
        <Text style={styles.paragraph}>
          {clean(data.forvaltningsberattelse.agm_result_disposition_decision) || 'Årsstämmans beslut har inte registrerats.'}
        </Text>
        <View style={styles.signatureLine}>
          <View style={styles.signatureSlot}>
            <Text>{clean(data.forvaltningsberattelse.certificate_signer_name) || ' '}</Text>
          </View>
          <Text style={{ width: 240 }}>{clean(data.forvaltningsberattelse.certificate_signer_role) || 'Styrelseledamot (närvarande vid stämman)'}</Text>
        </View>
        <Text style={[styles.paragraph, { marginTop: 30, fontSize: 9, color: '#666' }]}>
          {data.company.city ? `${data.company.city}, ` : ''}
          datum: {data.forvaltningsberattelse.certificate_signed_at?.slice(0, 10) ?? '____________________'}
        </Text>
      </Page>
    </Document>
  )
}
