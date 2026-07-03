/**
 * Go-live readiness registry.
 *
 * Computes, per external integration, whether the deployment is production
 * ready, sandbox ready, technically prepared but awaiting an external
 * agreement, not configured, or misconfigured — purely from environment
 * configuration. Pure function over an env record so it is unit-testable
 * and safe to call from the platform UI and /api/health/deep.
 *
 * Statuses:
 *   production_ready   — full production configuration present
 *   sandbox_ready      — test/sandbox mode works end to end
 *   requires_agreement — code is ready; an external agreement/certificate
 *                        must be signed before credentials exist
 *   not_configured     — optional integration, nothing set
 *   misconfigured      — partial configuration (some required vars missing)
 *   blocked            — explicitly disabled via kill switch
 */

export type IntegrationReadinessStatus =
  | 'production_ready'
  | 'sandbox_ready'
  | 'requires_agreement'
  | 'not_configured'
  | 'misconfigured'
  | 'blocked'

export type IntegrationResponsible = 'superadmin' | 'company' | 'agency'

export interface IntegrationReadinessEntry {
  id: string
  name: string
  /** Who acts to change the status. */
  responsible: IntegrationResponsible
  status: IntegrationReadinessStatus
  message_sv: string
  missingEnvVars: string[]
  docsPath: string | null
}

export const READINESS_STATUS_LABELS_SV: Record<IntegrationReadinessStatus, string> = {
  production_ready: 'Produktionsklar',
  sandbox_ready: 'Sandbox-klar',
  requires_agreement: 'Kräver externt avtal',
  not_configured: 'Ej konfigurerad',
  misconfigured: 'Felkonfigurerad',
  blocked: 'Blockerad',
}

type Env = Record<string, string | undefined>

function present(env: Env, key: string): boolean {
  return !!env[key] && env[key]!.trim().length > 0
}

function missing(env: Env, keys: string[]): string[] {
  return keys.filter((k) => !present(env, k))
}

/**
 * Group check: all present → ok; none → empty; some → the missing ones.
 * Returns { state: 'all' | 'none' | 'partial', missing }.
 */
function groupState(env: Env, keys: string[]): { state: 'all' | 'none' | 'partial'; missing: string[] } {
  const miss = missing(env, keys)
  if (miss.length === 0) return { state: 'all', missing: [] }
  if (miss.length === keys.length) return { state: 'none', missing: miss }
  return { state: 'partial', missing: miss }
}

export function computeIntegrationReadiness(env: Env = process.env): IntegrationReadinessEntry[] {
  const entries: IntegrationReadinessEntry[] = []

  // ── BankID (via TIC Identity) ──────────────────────────────────────────────
  {
    const hasTic = present(env, 'TIC_IDENTITY_API_KEY')
    const mode = env.BANKID_PROVIDER_MODE
    let status: IntegrationReadinessStatus
    let message = ''
    if (hasTic && mode !== 'test' && mode !== 'mock') {
      status = 'production_ready'
      message = 'TIC Identity är konfigurerat i produktionsläge.'
    } else if (hasTic) {
      status = 'sandbox_ready'
      message = 'TIC Identity kör mot BankID:s testmiljö (BANKID_PROVIDER_MODE).'
    } else if (mode === 'mock') {
      status = 'sandbox_ready'
      message = 'Mock-providern är aktiv — signering fungerar för test/demo.'
    } else {
      status = 'requires_agreement'
      message = 'BankID i produktion kräver avtal med en identitetsleverantör (t.ex. TIC Identity). Sätt TIC_IDENTITY_API_KEY.'
    }
    entries.push({
      id: 'bankid', name: 'BankID (signering & samtycken)', responsible: 'superadmin',
      status, message_sv: message,
      missingEnvVars: hasTic ? [] : ['TIC_IDENTITY_API_KEY'],
      docsPath: '/settings/bankid',
    })
  }

  // ── Skatteverket (BankID OAuth track) ─────────────────────────────────────
  {
    const keys = ['SKATTEVERKET_OAUTH2_CLIENT_ID', 'SKATTEVERKET_OAUTH2_CLIENT_SECRET', 'SKATTEVERKET_APIGW_CLIENT_ID', 'SKATTEVERKET_APIGW_CLIENT_SECRET', 'SKATTEVERKET_TOKEN_ENCRYPTION_KEY']
    const g = groupState(env, keys)
    let status: IntegrationReadinessStatus
    let message = ''
    if (env.SKATTEVERKET_DISABLED === 'true') {
      status = 'blocked'
      message = 'Avstängd via SKATTEVERKET_DISABLED.'
    } else if (g.state === 'all') {
      const prod = env.SKATTEVERKET_ENV === 'production' || env.SKATTEVERKET_ENV === 'prod'
      status = prod ? 'production_ready' : 'sandbox_ready'
      message = prod ? 'Fullständiga produktionsuppgifter finns.' : 'Konfigurerad mot Skatteverkets testmiljö.'
    } else if (g.state === 'none') {
      status = 'requires_agreement'
      message = 'API-uppgifter utfärdas i Skatteverkets API-portal efter ansökan. Manuell inlämning via Mina sidor fungerar alltid.'
    } else {
      status = 'misconfigured'
      message = `Ofullständig konfiguration — saknar ${g.missing.join(', ')}.`
    }
    entries.push({
      id: 'skatteverket', name: 'Skatteverket (moms/AGI/skattekonto)', responsible: 'superadmin',
      status, message_sv: message, missingEnvVars: g.missing, docsPath: '/skatteverket',
    })
  }

  // ── Enable Banking (PSD2) ──────────────────────────────────────────────────
  {
    const prodKeys = ['ENABLE_BANKING_APP_ID_PRODUCTION', 'ENABLE_BANKING_PRIVATE_KEY_PRODUCTION']
    const sandboxKeys = ['ENABLE_BANKING_APP_ID', 'ENABLE_BANKING_PRIVATE_KEY']
    const prod = groupState(env, prodKeys)
    const sandbox = groupState(env, sandboxKeys)
    let status: IntegrationReadinessStatus
    let message = ''
    let miss: string[] = []
    if (prod.state === 'all') {
      status = 'production_ready'
      message = 'Produktionsapp registrerad hos Enable Banking.'
    } else if (sandbox.state === 'all') {
      status = 'sandbox_ready'
      message = 'Sandbox-app konfigurerad — riktiga banker kräver Enable Bankings produktionsgodkännande.'
      miss = prod.missing
    } else if (sandbox.state === 'partial' || prod.state === 'partial') {
      status = 'misconfigured'
      miss = sandbox.state === 'partial' ? sandbox.missing : prod.missing
      message = `Ofullständig konfiguration — saknar ${miss.join(', ')}.`
    } else {
      status = 'requires_agreement'
      miss = sandboxKeys
      message = 'PSD2-åtkomst kräver ett Enable Banking-konto. Manuell bankfilsimport (camt/CSV) fungerar utan avtal.'
    }
    entries.push({
      id: 'enable_banking', name: 'Enable Banking (PSD2-bankkoppling)', responsible: 'superadmin',
      status, message_sv: message, missingEnvVars: miss, docsPath: '/settings/banking',
    })
  }

  // ── Bankgiro/Autogiro ──────────────────────────────────────────────────────
  entries.push({
    id: 'bankgiro', name: 'Bankgiro/Autogiro', responsible: 'company',
    status: 'requires_agreement',
    message_sv: 'Bankgironummer och Autogiro tecknas via företagets bank (Bankgirocentralen). Nordklart förbereder ansökan och hanterar filformaten (BG Max, LB, pain.001/002).',
    missingEnvVars: [], docsPath: '/bankgiro',
  })

  // ── Peppol e-invoicing ─────────────────────────────────────────────────────
  {
    const provider = env.PEPPOL_PROVIDER
    const isProd = env.NODE_ENV === 'production' && env.NEXT_PUBLIC_SELF_HOSTED !== 'true'
    const sandboxActive = provider === 'sandbox' || (!provider && !isProd)
    entries.push({
      id: 'peppol', name: 'Peppol e-faktura', responsible: 'superadmin',
      status: sandboxActive ? 'sandbox_ready' : 'requires_agreement',
      message_sv: sandboxActive
        ? 'Sandbox-accesspunkten är aktiv — produktion kräver avtal med en certifierad Peppol-accesspunkt.'
        : 'Kräver avtal med en certifierad Peppol-accesspunkt (Pagero/InExchange/Qvalia). PDF/e-post-fallback fungerar alltid.',
      missingEnvVars: sandboxActive ? [] : ['PEPPOL_PROVIDER'],
      docsPath: null,
    })
  }

  // ── Invoice financing ──────────────────────────────────────────────────────
  {
    const provider = env.INVOICE_FINANCING_PROVIDER
    const isProd = env.NODE_ENV === 'production' && env.NEXT_PUBLIC_SELF_HOSTED !== 'true'
    const sandboxActive = provider === 'sandbox' || (!provider && !isProd)
    entries.push({
      id: 'invoice_financing', name: 'Fakturafinansiering', responsible: 'superadmin',
      status: sandboxActive ? 'sandbox_ready' : 'requires_agreement',
      message_sv: sandboxActive
        ? 'Sandbox-finansiären är aktiv — hela flödet kan testas. Produktion kräver avtal med en finansieringspartner.'
        : 'Kräver avtal med en finansieringspartner.',
      missingEnvVars: [], docsPath: null,
    })
  }

  // ── Accounting-system providers ───────────────────────────────────────────
  const providerDefs: Array<{ id: string; name: string; keys: string[]; agreement_sv: string }> = [
    { id: 'fortnox', name: 'Fortnox (migrering)', keys: ['FORTNOX_CLIENT_ID', 'FORTNOX_CLIENT_SECRET'], agreement_sv: 'OAuth-klient utfärdas i Fortnox utvecklarportal.' },
    { id: 'visma', name: 'Visma eEkonomi (migrering)', keys: ['VISMA_CLIENT_ID', 'VISMA_CLIENT_SECRET'], agreement_sv: 'OAuth-klient utfärdas i Visma Developer Portal.' },
    { id: 'briox', name: 'Briox (migrering)', keys: ['BRIOX_CLIENT_ID'], agreement_sv: 'Integrationsklient utfärdas av Briox.' },
    { id: 'bjornlunden', name: 'Björn Lundén (migrering)', keys: ['BJORN_LUNDEN_CLIENT_ID', 'BJORN_LUNDEN_CLIENT_SECRET'], agreement_sv: 'App-uppgifter utfärdas i Björn Lundéns integrationsprogram.' },
  ]
  for (const def of providerDefs) {
    const g = groupState(env, def.keys)
    entries.push({
      id: def.id, name: def.name, responsible: 'superadmin',
      status: g.state === 'all' ? 'production_ready' : g.state === 'none' ? 'requires_agreement' : 'misconfigured',
      message_sv:
        g.state === 'all'
          ? 'Klientuppgifter konfigurerade.'
          : g.state === 'none'
            ? def.agreement_sv
            : `Ofullständig konfiguration — saknar ${g.missing.join(', ')}.`,
      missingEnvVars: g.missing, docsPath: '/extensions',
    })
  }

  // Bokio: private API token pasted by the user — no platform-side env needed.
  entries.push({
    id: 'bokio', name: 'Bokio (migrering)', responsible: 'company',
    status: 'production_ready',
    message_sv: 'Användaren klistrar in sin privata API-nyckel från Bokio — ingen plattformskonfiguration krävs.',
    missingEnvVars: [], docsPath: '/extensions',
  })

  // ── Bolagsverket ───────────────────────────────────────────────────────────
  {
    const g = groupState(env, ['BOLAGSVERKET_CLIENT_ID', 'BOLAGSVERKET_CLIENT_SECRET'])
    entries.push({
      id: 'bolagsverket', name: 'Bolagsverket (företagsuppslag)', responsible: 'superadmin',
      status: g.state === 'all' ? 'production_ready' : g.state === 'none' ? 'requires_agreement' : 'misconfigured',
      message_sv:
        g.state === 'all'
          ? 'API-uppgifter konfigurerade.'
          : g.state === 'none'
            ? 'API-åtkomst ansöks hos Bolagsverket. Manuell inmatning av företagsuppgifter fungerar utan.'
            : `Ofullständig konfiguration — saknar ${g.missing.join(', ')}.`,
      missingEnvVars: g.missing, docsPath: null,
    })
  }

  // ── Resend (e-post) ────────────────────────────────────────────────────────
  {
    const ok = present(env, 'RESEND_API_KEY')
    entries.push({
      id: 'resend', name: 'Resend (e-postutskick)', responsible: 'superadmin',
      status: ok ? 'production_ready' : 'not_configured',
      message_sv: ok ? 'API-nyckel konfigurerad.' : 'Sätt RESEND_API_KEY för fakturautskick och notiser via e-post.',
      missingEnvVars: ok ? [] : ['RESEND_API_KEY'],
      docsPath: null,
    })
  }

  // ── Stripe (betalning/prenumeration) ───────────────────────────────────────
  {
    const g = groupState(env, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'])
    let status: IntegrationReadinessStatus
    let message = ''
    if (g.state === 'all') {
      const testMode = env.STRIPE_SECRET_KEY!.startsWith('sk_test')
      status = testMode ? 'sandbox_ready' : 'production_ready'
      message = testMode ? 'Stripe kör i testläge (sk_test-nyckel).' : 'Stripe är konfigurerat för produktion.'
    } else if (g.state === 'none') {
      status = 'not_configured'
      message = 'Sätt STRIPE_SECRET_KEY och STRIPE_WEBHOOK_SECRET för prenumerationer och betalningar.'
    } else {
      status = 'misconfigured'
      message = `Ofullständig konfiguration — saknar ${g.missing.join(', ')}.`
    }
    entries.push({
      id: 'stripe', name: 'Stripe (prenumerationer)', responsible: 'superadmin',
      status, message_sv: message, missingEnvVars: g.missing, docsPath: '/platform/price-plans',
    })
  }

  return entries
}
