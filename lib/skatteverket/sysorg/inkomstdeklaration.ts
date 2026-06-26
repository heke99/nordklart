import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { skvSysorgRequest } from './client'
import { getSkvFilframstallare } from './config'

type CallContext = {
  supabase?: SupabaseClient
  companyId?: string | null
  userId?: string | null
  requestId?: string | null
}

export type Ink1Deklarationsunderlag = {
  filframstallareOrgnr?: string
  filframstallareNamn?: string
  filframstallareKontaktperson?: string
  filframstallareEpost?: string
  filframstallareTelefon?: string | null
  deklarationBase64SRUZip: string
}

export function buildInk1Deklarationsunderlag(base64SruZip: string): Ink1Deklarationsunderlag {
  const fil = getSkvFilframstallare()
  return {
    filframstallareOrgnr: fil.id,
    filframstallareNamn: fil.name,
    filframstallareKontaktperson: fil.contactName,
    filframstallareEpost: fil.contactEmail,
    filframstallareTelefon: fil.contactPhone,
    deklarationBase64SRUZip: base64SruZip,
  }
}

export async function hamtaForifylldInk1(
  idPers: string,
  inkomstAr: number,
  format: 'sru' | 'pdf',
  ctx: CallContext = {},
) {
  return skvSysorgRequest<Blob | unknown>({
    ...ctx,
    service: 'ink1',
    method: 'GET',
    path: `/${encodeURIComponent(idPers)}/inkomstAr/${encodeURIComponent(String(inkomstAr))}/fortryckt`,
    accept: format === 'pdf' ? 'application/pdf' : 'application/x-skv269-sru',
    operation: `ink1.hamta_forifylld_${format}`,
  })
}

export async function lamnaInk1Deklarationsunderlag(
  idPers: string,
  underlag: Ink1Deklarationsunderlag,
  ctx: CallContext = {},
) {
  return skvSysorgRequest({
    ...ctx,
    service: 'ink1',
    method: 'POST',
    path: `/${encodeURIComponent(idPers)}/deklarationsunderlag`,
    body: underlag,
    operation: 'ink1.lamna_deklarationsunderlag',
  })
}

export type InkForetagDeklarationsunderlag = Record<string, unknown>

export async function lamnaInkForetagDeklarationsunderlag(
  path: string,
  underlag: InkForetagDeklarationsunderlag,
  ctx: CallContext = {},
) {
  // INK2–4 path differs between API-definition versions; call this only with a path
  // copied from Skatteverkets RAML/OpenAPI, for example from the authenticated portal.
  return skvSysorgRequest({
    ...ctx,
    service: 'inkForetag',
    method: 'POST',
    path,
    body: underlag,
    operation: 'inkforetag.lamna_deklarationsunderlag',
  })
}
