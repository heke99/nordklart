export const YEAR_END_PRODUCT_STEPS = [
  { key: 'start', label: 'Starta bokslut', description: 'Välj räkenskapsår och datakälla.' },
  { key: 'import', label: 'Importera SIE', description: 'SIE eller befintlig bokföring blir underlag.' },
  { key: 'checks', label: 'Kör kontroller', description: 'Perioder, moms, balans och avvikelser kontrolleras.' },
  { key: 'adjust', label: 'Justera', description: 'Periodiseringar, avskrivningar och bokslutsverifikationer.' },
  { key: 'package', label: 'Exportpaket', description: 'Rapporter, bilagor och låsning av år.' },
] as const

export function yearEndStatusLabel(status?: string | null) {
  const labels: Record<string, string> = {
    draft: 'Utkast',
    in_progress: 'Pågår',
    ready_for_review: 'Redo för granskning',
    completed: 'Klart',
    locked: 'Låst',
    cancelled: 'Avbrutet',
  }
  return labels[status ?? ''] ?? status ?? 'Okänd'
}

export function exportPackageLabel(status?: string | null) {
  const labels: Record<string, string> = {
    not_started: 'Ej startat',
    building: 'Byggs',
    ready: 'Redo',
    failed: 'Fel',
  }
  return labels[status ?? ''] ?? status ?? 'Ej startat'
}
