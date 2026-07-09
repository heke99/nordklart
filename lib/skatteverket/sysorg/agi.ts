import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { skvSysorgRequest } from './client'
import { assertSkatteverketSubmissionConsent } from './consent'

type CallContext = {
  supabase?: SupabaseClient
  companyId?: string | null
  userId?: string | null
  requestId?: string | null
}

function periodPath(arbetsgivare: string, redovisningsperiod: string): string {
  return `/arbetsgivare/${encodeURIComponent(arbetsgivare)}/redovisningsperioder/${encodeURIComponent(redovisningsperiod)}`
}

export async function lasInAgiUnderlag(xml: string, ctx: CallContext = {}) {
  // Loading an AGI underlag starts the filing flow on the company's behalf —
  // the customer's BankID-signed mandate must exist first.
  await assertSkatteverketSubmissionConsent(ctx.supabase, ctx.companyId)
  return skvSysorgRequest<{ inlamningId: number }>({
    ...ctx,
    service: 'agdInlamning',
    method: 'POST',
    path: '/underlag',
    body: xml,
    contentType: 'application/xml',
    operation: 'agi.las_in_underlag',
  })
}

export async function hamtaAgiKontrollresultat(inlamningId: number, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'agdInlamning',
    method: 'GET',
    path: `/underlag/${encodeURIComponent(String(inlamningId))}/kontrollresultat`,
    operation: 'agi.hamta_kontrollresultat',
  })
}

export async function sparaFelaktigtAgiUnderlag(inlamningId: number, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'agdInlamning',
    method: 'POST',
    path: `/underlag/${encodeURIComponent(String(inlamningId))}/spara`,
    operation: 'agi.spara_felaktigt_underlag',
  })
}

export async function avbrytAgiUnderlag(inlamningId: number, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'agdInlamning',
    method: 'DELETE',
    path: `/underlag/${encodeURIComponent(String(inlamningId))}`,
    operation: 'agi.avbryt_underlag',
  })
}

export async function skapaAgiGranskningsunderlag(
  arbetsgivare: string,
  redovisningsperiod: string,
  options: { lasPeriod?: boolean } = {},
  ctx: CallContext = {},
) {
  const query = options.lasPeriod ? '?lasPeriod=true' : ''
  return skvSysorgRequest({
    ...ctx,
    service: 'agdInlamning',
    method: 'POST',
    path: `${periodPath(arbetsgivare, redovisningsperiod)}/skapaGranskningsunderlag${query}`,
    operation: 'agi.skapa_granskningsunderlag',
  })
}

export async function taBortSparadAgiInlamning(
  arbetsgivare: string,
  redovisningsperiod: string,
  inlamningId: number,
  ctx: CallContext = {},
) {
  return skvSysorgRequest({
    ...ctx,
    service: 'agdInlamning',
    method: 'DELETE',
    path: `${periodPath(arbetsgivare, redovisningsperiod)}/inlamningar/${encodeURIComponent(String(inlamningId))}`,
    operation: 'agi.ta_bort_sparad_inlamning',
  })
}

export async function hamtaAgiGrunddata(arbetsgivare: string, redovisningsperiod: string, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'agdPeriod',
    method: 'GET',
    path: `${periodPath(arbetsgivare, redovisningsperiod)}/grunddata`,
    operation: 'agi.hamta_grunddata',
  })
}

export async function hamtaAgiHandelser(arbetsgivare: string, redovisningsperiod: string, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'agdPeriod',
    method: 'GET',
    path: `${periodPath(arbetsgivare, redovisningsperiod)}/handelser`,
    operation: 'agi.hamta_handelser',
  })
}

export async function hamtaAgiSummeringsrapport(arbetsgivare: string, redovisningsperiod: string, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'agdPeriod',
    method: 'GET',
    path: `${periodPath(arbetsgivare, redovisningsperiod)}/summeringsrapport`,
    operation: 'agi.hamta_summeringsrapport',
  })
}

export async function hamtaAgiKvittenser(arbetsgivare: string, redovisningsperiod: string, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'agdPeriod',
    method: 'GET',
    path: `${periodPath(arbetsgivare, redovisningsperiod)}/kvittenser`,
    operation: 'agi.hamta_kvittenser',
  })
}

export async function lasAgiRedovisningsperiod(arbetsgivare: string, redovisningsperiod: string, ctx: CallContext = {}) {
  await assertSkatteverketSubmissionConsent(ctx.supabase, ctx.companyId)
  return skvSysorgRequest({
    ...ctx,
    service: 'agdPeriod',
    method: 'POST',
    path: `${periodPath(arbetsgivare, redovisningsperiod)}/las`,
    operation: 'agi.las_period',
  })
}

export async function lasUppAgiRedovisningsperiod(arbetsgivare: string, redovisningsperiod: string, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'agdPeriod',
    method: 'POST',
    path: `${periodPath(arbetsgivare, redovisningsperiod)}/lasUpp`,
    operation: 'agi.las_upp_period',
  })
}

export async function kontrolleraAgiHuvuduppgift(huvuduppgift: Record<string, unknown>, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'agdInlamning',
    method: 'POST',
    path: '/underlag/huvuduppgift/kontrollera',
    body: huvuduppgift,
    operation: 'agi.kontrollera_hu',
  })
}

export async function kontrolleraAgiIndividuppgift(individuppgift: Record<string, unknown>, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'agdInlamning',
    method: 'POST',
    path: '/underlag/individuppgift/kontrollera',
    body: individuppgift,
    operation: 'agi.kontrollera_iu',
  })
}
