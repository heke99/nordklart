import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { skvSysorgRequest } from './client'
import { assertSkatteverketSubmissionConsent } from './consent'

export type Momsuppgift = {
  momspliktigForsaljning?: number
  momspliktigaUttag?: number
  vinstmarginal?: number
  hyresInkomst?: number
  momsForsaljningUtgaendeHog?: number
  momsForsaljningUtgaendeMedel?: number
  momsForsaljningUtgaendeLag?: number
  inkopVarorEU?: number
  inkopTjansterEU?: number
  inkopTjansterUtanforEU?: number
  inkopVarorSE?: number
  inkopTjansterSE?: number
  momsInkopUtgaendeHog?: number
  momsInkopUtgaendeMedel?: number
  momsInkopUtgaendeLag?: number
  forsaljningVarorEU?: number
  forsaljningVarorUtanforEU?: number
  inkopVaror3pHandel?: number
  forsaljningVaror3pHandel?: number
  forsaljningTjansterEU?: number
  ovrigForsaljningTjansterUtanforSE?: number
  forsaljningBskKopareSE?: number
  momsfriForsaljning?: number
  import?: number
  momsImportUtgaendeHog?: number
  momsImportUtgaendeMedel?: number
  momsImportUtgaendeLag?: number
  ingaendeMomsAvdrag?: number
  summaMoms: number
}

type CallContext = {
  supabase?: SupabaseClient
  companyId?: string | null
  userId?: string | null
  requestId?: string | null
}

function periodPath(redovisare: string, redovisningsperiod: string): string {
  return `${encodeURIComponent(redovisare)}/${encodeURIComponent(redovisningsperiod)}`
}

export async function kontrolleraMomsdeklaration(
  redovisare: string,
  redovisningsperiod: string,
  momsuppgift: Momsuppgift,
  ctx: CallContext = {},
) {
  return skvSysorgRequest({
    ...ctx,
    service: 'momsdeklaration',
    method: 'POST',
    path: `/kontrollera/${periodPath(redovisare, redovisningsperiod)}`,
    body: momsuppgift,
    operation: 'moms.kontrollera',
  })
}

export async function sparaMomsdeklarationsutkast(
  redovisare: string,
  redovisningsperiod: string,
  momsuppgift: Momsuppgift,
  options: { las?: boolean } = {},
  ctx: CallContext = {},
) {
  // las=true locks the draft for filing — that is the submission boundary
  // and legally requires the customer's BankID-signed mandate.
  if (options.las) await assertSkatteverketSubmissionConsent(ctx.supabase, ctx.companyId)
  const query = options.las ? '?las=true' : ''
  return skvSysorgRequest({
    ...ctx,
    service: 'momsdeklaration',
    method: 'POST',
    path: `/utkast/${periodPath(redovisare, redovisningsperiod)}${query}`,
    body: momsuppgift,
    operation: 'moms.spara_utkast',
  })
}

export async function hamtaMomsdeklarationsutkast(redovisare: string, redovisningsperiod: string, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'momsdeklaration',
    method: 'GET',
    path: `/utkast/${periodPath(redovisare, redovisningsperiod)}`,
    operation: 'moms.hamta_utkast',
  })
}

export async function raderaMomsdeklarationsutkast(redovisare: string, redovisningsperiod: string, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'momsdeklaration',
    method: 'DELETE',
    path: `/utkast/${periodPath(redovisare, redovisningsperiod)}`,
    operation: 'moms.radera_utkast',
  })
}

export async function lasMomsdeklarationsutkast(redovisare: string, redovisningsperiod: string, ctx: CallContext = {}) {
  await assertSkatteverketSubmissionConsent(ctx.supabase, ctx.companyId)
  return skvSysorgRequest({
    ...ctx,
    service: 'momsdeklaration',
    method: 'PUT',
    path: `/las/${periodPath(redovisare, redovisningsperiod)}`,
    operation: 'moms.las_utkast',
  })
}

export async function lasUppMomsdeklarationsutkast(redovisare: string, redovisningsperiod: string, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'momsdeklaration',
    method: 'DELETE',
    path: `/las/${periodPath(redovisare, redovisningsperiod)}`,
    operation: 'moms.las_upp_utkast',
  })
}

export async function hamtaInlamnadeMomsuppgifter(redovisare: string, redovisningsperiod: string, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'momsdeklaration',
    method: 'GET',
    path: `/inlamnat/${periodPath(redovisare, redovisningsperiod)}`,
    operation: 'moms.hamta_inlamnat',
  })
}

export async function hamtaBeslutadeMomsuppgifter(redovisare: string, redovisningsperiod: string, ctx: CallContext = {}) {
  return skvSysorgRequest({
    ...ctx,
    service: 'momsdeklaration',
    method: 'GET',
    path: `/beslutat/${periodPath(redovisare, redovisningsperiod)}`,
    operation: 'moms.hamta_beslutat',
  })
}
