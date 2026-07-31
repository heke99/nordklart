import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import type { ArsredovisningData, EgenKapitalRow } from './types'
import { formatAnnualReportAmount, normalizeAnnualReportText } from './format'

const styles = StyleSheet.create({
  page: {
    paddingTop: 50,
    paddingHorizontal: 50,
    paddingBottom: 65,
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
    bottom: 28,
    left: 50,
    right: 50,
    fontSize: 8,
    color: '#666',
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
    marginBottom: 50,
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
  sourceText: {
    marginBottom: 8,
    fontSize: 8,
    color: '#555',
    lineHeight: 1.35,
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
  colLabel: { flex: 1 },
  colLabelIndent: { flex: 1, paddingLeft: 12 },
  colAmount: { width: 100, textAlign: 'right' },
  equityLabel: { flex: 1 },
  equityAmount: { width: 78, textAlign: 'right' },
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
})

function fmt(amount: number): string {
  return formatAnnualReportAmount(amount, { decimals: 0 })
}

function clean(value: string | null | undefined): string {
  return normalizeAnnualReportText(value ?? '')
}

function comparisonSource(data: ArsredovisningData): string | null {
  if (!data.prior_period) return null
  const details = [
    `Jämförelsetal ${clean(data.prior_period.name)}`,
    data.prior_period.source_label ? `Källa: ${clean(data.prior_period.source_label)}` : null,
    data.prior_period.verified_at
      ? `Verifierad: ${data.prior_period.verified_at.slice(0, 10)}${data.prior_period.verified_by ? ` av ${clean(data.prior_period.verified_by)}` : ''}`
      : null,
  ].filter(Boolean)
  return details.join(' · ')
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
        <Text>{clean(data.company.name)} · {clean(data.company.org_number)}</Text>
        <Text>
          Årsredovisning {clean(data.fiscal_period.name)}
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

function EquityCell({ value }: { value: number | undefined }) {
  return <Text style={styles.equityAmount}>{value === undefined ? '—' : fmt(value)}</Text>
}

function EquityRow({ row }: { row: EgenKapitalRow }) {
  const rowStyle = row.row_kind === 'opening' || row.row_kind === 'closing'
    ? styles.tableRowTotal
    : styles.tableRow
  return (
    <View style={rowStyle}>
      <Text style={styles.equityLabel}>{clean(row.label)}</Text>
      <EquityCell value={row.aktiekapital} />
      <EquityCell value={row.balanserat_resultat} />
      <EquityCell value={row.arets_resultat} />
      <Text style={styles.equityAmount}>{fmt(row.amount)}</Text>
    </View>
  )
}

export function ArsredovisningPDF({
  data,
  isDraft = true,
  draftBlockers = [],
}: {
  data: ArsredovisningData
  isDraft?: boolean
  draftBlockers?: string[]
}) {
  const comparison = comparisonSource(data)
  const signedDates = data.signatures
    .map((signature) => signature.signed_at?.slice(0, 10) ?? null)
    .filter((value): value is string => Boolean(value))
    .sort()
  const latestSignatureDate = signedDates.at(-1) ?? null

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Försättssida" />
        <View>
          <Text style={styles.title}>Årsredovisning</Text>
          <Text style={styles.subtitle}>
            för räkenskapsåret {data.fiscal_period.period_start} - {data.fiscal_period.period_end}
          </Text>
          <Text style={styles.paragraph}>{clean(data.company.name)}</Text>
          <Text style={styles.paragraph}>Organisationsnummer: {clean(data.company.org_number)}</Text>
          {data.company.prior_legal_name ? (
            <Text style={styles.paragraph}>Tidigare företagsnamn: {clean(data.company.prior_legal_name)}</Text>
          ) : null}
          {data.company.city ? <Text style={styles.paragraph}>Säte: {clean(data.company.city)}</Text> : null}
          {isDraft && draftBlockers.length > 0 ? (
            <View style={{ marginTop: 40 }}>
              <Text style={styles.sectionTitle}>Kvarvarande blockerare</Text>
              {draftBlockers.map((blocker, index) => (
                <Text key={`${blocker}-${index}`} style={styles.paragraph}>• {clean(blocker)}</Text>
              ))}
            </View>
          ) : null}
        </View>
      </Page>

      <Page size="A4" style={styles.page}>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Förvaltningsberättelse" />
        <Text style={styles.sectionTitle}>Förvaltningsberättelse</Text>

        <Text style={styles.sectionTitle}>Verksamhet</Text>
        <Text style={styles.paragraph}>{clean(data.forvaltningsberattelse.description)}</Text>

        <Text style={styles.sectionTitle}>Väsentliga händelser under räkenskapsåret</Text>
        <Text style={styles.paragraph}>{clean(data.forvaltningsberattelse.important_events)}</Text>

        <Text style={styles.sectionTitle}>Händelser efter balansdagen</Text>
        <Text style={styles.paragraph}>{clean(data.forvaltningsberattelse.events_after_balance_sheet)}</Text>

        {data.forvaltningsberattelse.kontrollbalans_required ? (
          <>
            <Text style={styles.sectionTitle}>Kontrollbalansräkning</Text>
            <Text style={styles.paragraph}>
              Kontrollbalansräkning har upprättats under räkenskapsåret enligt ABL 25 kap.
            </Text>
          </>
        ) : null}

        <Text style={styles.sectionTitle}>Flerårsöversikt (kr)</Text>
        {comparison ? <Text style={styles.sourceText}>{comparison}</Text> : null}
        <View style={styles.tableHeader}>
          <Text style={styles.colLabel}>År</Text>
          <Text style={styles.colAmount}>Nettoomsättning</Text>
          <Text style={styles.colAmount}>Resultat e.fin.poster</Text>
          <Text style={styles.colAmount}>Soliditet (%)</Text>
        </View>
        {data.forvaltningsberattelse.flerarsoversikt.map((row) => (
          <View key={row.year} style={styles.tableRow}>
            <Text style={styles.colLabel}>{clean(row.year)}</Text>
            <Text style={styles.colAmount}>{row.data_missing ? 'Saknas' : fmt(row.net_revenue)}</Text>
            <Text style={styles.colAmount}>{row.data_missing ? 'Saknas' : fmt(row.result_after_financial)}</Text>
            <Text style={styles.colAmount}>
              {row.data_missing ? 'Saknas' : row.soliditet_pct === null ? '—' : row.soliditet_pct.toFixed(1)}
            </Text>
          </View>
        ))}

        <Text style={styles.sectionTitle}>Förändring av eget kapital (kr)</Text>
        <View style={styles.tableHeader}>
          <Text style={styles.equityLabel}>Förändring</Text>
          <Text style={styles.equityAmount}>Aktiekapital</Text>
          <Text style={styles.equityAmount}>Balanserat</Text>
          <Text style={styles.equityAmount}>Årets resultat</Text>
          <Text style={styles.equityAmount}>Summa</Text>
        </View>
        {data.forvaltningsberattelse.egen_kapital_changes.map((row, index) => (
          <EquityRow key={`${row.label}-${index}`} row={row} />
        ))}

        <Text style={styles.sectionTitle}>Styrelsens förslag till resultatdisposition</Text>
        <Text style={styles.paragraph}>{clean(data.forvaltningsberattelse.resultatdisposition)}</Text>
      </Page>

      <Page size="A4" style={styles.page}>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Resultaträkning" />
        <Text style={styles.sectionTitle}>Resultaträkning (kr)</Text>
        {comparison ? <Text style={styles.sourceText}>{comparison}</Text> : null}
        <View style={styles.tableHeader}>
          <Text style={styles.colLabel}>Post</Text>
          <Text style={styles.colAmount}>{clean(data.fiscal_period.name)}</Text>
          {data.prior_period ? <Text style={styles.colAmount}>{clean(data.prior_period.name)}</Text> : null}
        </View>
        {data.resultatrakning.map((line, index) => (
          <View key={`${line.label}-${index}`} style={line.is_total ? styles.tableRowTotal : styles.tableRow}>
            <Text style={styles.colLabel}>{clean(line.label)}</Text>
            <Text style={styles.colAmount}>{fmt(line.amount)}</Text>
            {data.prior_period ? (
              <Text style={styles.colAmount}>{line.prior_amount == null ? '—' : fmt(line.prior_amount)}</Text>
            ) : null}
          </View>
        ))}
      </Page>

      <Page size="A4" style={styles.page}>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Balansräkning" />
        <Text style={styles.sectionTitle}>Tillgångar (kr)</Text>
        {comparison ? <Text style={styles.sourceText}>{comparison}</Text> : null}
        <View style={styles.tableHeader}>
          <Text style={styles.colLabel}>Post</Text>
          <Text style={styles.colAmount}>{clean(data.fiscal_period.period_end)}</Text>
          {data.prior_period ? <Text style={styles.colAmount}>{clean(data.prior_period.name)}</Text> : null}
        </View>
        {data.balansrakning.assets.map((line, index) => (
          <View key={`${line.label}-${index}`} style={line.is_total ? styles.tableRowTotal : styles.tableRow}>
            <Text style={line.indent ? styles.colLabelIndent : styles.colLabel}>{clean(line.label)}</Text>
            <Text style={styles.colAmount}>{fmt(line.amount)}</Text>
            {data.prior_period ? (
              <Text style={styles.colAmount}>{line.prior_amount == null ? '—' : fmt(line.prior_amount)}</Text>
            ) : null}
          </View>
        ))}
        <View style={styles.tableRowTotal}>
          <Text style={styles.colLabel}>Summa tillgångar</Text>
          <Text style={styles.colAmount}>{fmt(data.balansrakning.total_assets)}</Text>
          {data.prior_period ? (
            <Text style={styles.colAmount}>
              {data.balansrakning.total_assets_prior == null ? '—' : fmt(data.balansrakning.total_assets_prior)}
            </Text>
          ) : null}
        </View>

        <Text style={styles.sectionTitle}>Eget kapital och skulder (kr)</Text>
        {data.balansrakning.equity_liabilities.map((line, index) => (
          <View key={`${line.label}-${index}`} style={line.is_total ? styles.tableRowTotal : styles.tableRow}>
            <Text style={line.indent ? styles.colLabelIndent : styles.colLabel}>{clean(line.label)}</Text>
            <Text style={styles.colAmount}>{fmt(line.amount)}</Text>
            {data.prior_period ? (
              <Text style={styles.colAmount}>{line.prior_amount == null ? '—' : fmt(line.prior_amount)}</Text>
            ) : null}
          </View>
        ))}
        <View style={styles.tableRowTotal}>
          <Text style={styles.colLabel}>Summa eget kapital och skulder</Text>
          <Text style={styles.colAmount}>{fmt(data.balansrakning.total_equity_liabilities)}</Text>
          {data.prior_period ? (
            <Text style={styles.colAmount}>
              {data.balansrakning.total_equity_liabilities_prior == null
                ? '—'
                : fmt(data.balansrakning.total_equity_liabilities_prior)}
            </Text>
          ) : null}
        </View>
      </Page>

      <Page size="A4" style={styles.page}>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Noter" />
        <Text style={styles.sectionTitle}>Noter</Text>
        {data.noter.map((note) => (
          <View key={note.number} style={{ marginBottom: 16 }}>
            <Text style={{ fontFamily: 'Helvetica-Bold', marginBottom: 4 }}>
              Not {note.number} - {clean(note.title)}
            </Text>
            <Text style={styles.noteBody}>{clean(note.body)}</Text>
          </View>
        ))}
      </Page>

      <Page size="A4" style={styles.page}>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Underskrifter" />
        <Text style={styles.sectionTitle}>Underskrifter</Text>
        <Text style={styles.paragraph}>
          {data.company.city ? `${clean(data.company.city)}, ` : ''}
          {latestSignatureDate ?? 'underskriftsdatum saknas'}
        </Text>
        {data.signatures.length > 0 ? (
          data.signatures.map((signature, index) => (
            <View key={`${signature.name}-${index}`} style={styles.signatureLine}>
              <View style={styles.signatureSlot}>
                <Text>{clean(signature.name) || ' '}</Text>
              </View>
              <Text style={{ width: 180 }}>
                {clean(signature.role)}
                {signature.signed_at ? ` - signerad ${signature.signed_at.slice(0, 10)}` : ' - ej signerad'}
              </Text>
            </View>
          ))
        ) : (
          <Text style={styles.paragraph}>
            Inga undertecknare är registrerade. Registrera samtliga obligatoriska undertecknare innan dokumentet färdigställs.
          </Text>
        )}
      </Page>

      <Page size="A4" style={styles.page}>
        <PageChrome data={data} isDraft={isDraft} pageLabel="Fastställelseintyg" />
        <Text style={styles.sectionTitle}>Fastställelseintyg</Text>
        <Text style={styles.paragraph}>
          Undertecknad {clean(data.forvaltningsberattelse.certificate_signer_role) || 'styrelseledamot'},
          närvarande vid årsstämman, intygar att resultaträkningen och balansräkningen
          {data.forvaltningsberattelse.agm_accounts_adopted === true ? ' har fastställts' : ' ännu inte har bekräftats som fastställda'}
          {' '}på årsstämma den {data.forvaltningsberattelse.agm_date ?? '____________________'}.
        </Text>
        <Text style={styles.sectionTitle}>Årsstämmans beslut om resultatdisposition</Text>
        <Text style={styles.paragraph}>
          {clean(data.forvaltningsberattelse.agm_result_disposition_decision) || 'Årsstämmans beslut har inte registrerats.'}
        </Text>
        <View style={styles.signatureLine}>
          <View style={styles.signatureSlot}>
            <Text>{clean(data.forvaltningsberattelse.certificate_signer_name) || ' '}</Text>
          </View>
          <Text style={{ width: 240 }}>
            {clean(data.forvaltningsberattelse.certificate_signer_role) || 'Styrelseledamot (närvarande vid stämman)'}
          </Text>
        </View>
        <Text style={[styles.paragraph, { marginTop: 30, fontSize: 9, color: '#666' }]}>
          {data.company.city ? `${clean(data.company.city)}, ` : ''}
          datum: {data.forvaltningsberattelse.certificate_signed_at?.slice(0, 10) ?? '____________________'}
        </Text>
      </Page>
    </Document>
  )
}
