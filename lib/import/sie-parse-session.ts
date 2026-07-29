import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateFileHash, decodeBuffer, detectEncoding } from './sie-parser'
import type { ParsedSIEFile } from './types'
import type { SIECompanyIdentityResult } from './company-identity'

export interface SIEParseSessionRecord {
  id: string
  company_id: string
  user_id: string
  file_name: string
  file_hash: string
  archive_hash: string
  storage_path: string
  parser_version: string
  parsed_header: Record<string, unknown>
  detected_source_system: string | null
  identity_status: SIECompanyIdentityResult['status']
  status: 'validating' | 'staged' | 'failed' | 'completed' | 'expired'
  replace_import_id: string | null
  sie_import_id: string | null
  expires_at: string
}

const PARSER_VERSION = 'nordklart-sie-parser/2026-07-29'

export async function calculateSIEArchiveHash(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes)
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function archiveSIEParseSession(input: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  fileName: string
  rawBytes: Uint8Array
  fileHash: string
  parsed: ParsedSIEFile
  identity: SIECompanyIdentityResult
  replaceImportId?: string | null
}): Promise<{ id: string; storagePath: string }> {
  const sessionId = crypto.randomUUID()
  const storagePath = `${input.companyId}/sessions/${sessionId}/${input.fileHash}.se`
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const archiveHash = await calculateSIEArchiveHash(input.rawBytes)

  const { error: insertError } = await input.supabase
    .from('sie_parse_sessions')
    .insert({
      id: sessionId,
      company_id: input.companyId,
      user_id: input.userId,
      file_name: input.fileName,
      file_hash: input.fileHash,
      archive_hash: archiveHash,
      storage_path: storagePath,
      parser_version: PARSER_VERSION,
      parsed_header: input.parsed.header,
      detected_source_system: input.parsed.header.program,
      identity_status: input.identity.status,
      identity_result: input.identity,
      status: 'validating',
      replace_import_id: input.replaceImportId ?? null,
      expires_at: expiresAt,
    })

  if (insertError) {
    throw new Error(`Importsessionen kunde inte skapas: ${insertError.message}`)
  }

  const { error: uploadError } = await input.supabase.storage
    .from('sie-files')
    .upload(storagePath, input.rawBytes, {
      contentType: 'text/plain',
      upsert: false,
    })

  if (uploadError) {
    await input.supabase
      .from('sie_parse_sessions')
      .update({
        status: 'failed',
        error_message: `Originalfilen kunde inte arkiveras: ${uploadError.message}`,
      })
      .eq('id', sessionId)
      .eq('company_id', input.companyId)
    throw new Error(
      `Originalfilen kunde inte arkiveras före import: ${uploadError.message}`,
    )
  }

  const finalStatus = input.identity.status === 'match' ? 'staged' : 'failed'
  const { error: updateError } = await input.supabase
    .from('sie_parse_sessions')
    .update({
      status: finalStatus,
      archived_at: new Date().toISOString(),
      error_message:
        finalStatus === 'failed' ? input.identity.message : null,
    })
    .eq('id', sessionId)
    .eq('company_id', input.companyId)

  if (updateError) {
    throw new Error(
      `Importsessionen kunde inte finaliseras: ${updateError.message}`,
    )
  }

  return { id: sessionId, storagePath }
}

export async function loadArchivedSIEParseSession(input: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  sessionId: string
}): Promise<{
  session: SIEParseSessionRecord
  rawBytes: Uint8Array
  content: string
}> {
  const { data, error } = await input.supabase
    .from('sie_parse_sessions')
    .select(
      'id,company_id,user_id,file_name,file_hash,archive_hash,storage_path,parser_version,parsed_header,detected_source_system,identity_status,status,replace_import_id,sie_import_id,expires_at',
    )
    .eq('id', input.sessionId)
    .eq('company_id', input.companyId)
    .eq('user_id', input.userId)
    .maybeSingle()

  if (error || !data) {
    throw new Error(
      `SIE_PARSE_SESSION_NOT_FOUND: ${error?.message ?? 'sessionen saknas'}`,
    )
  }

  const session = data as SIEParseSessionRecord
  if (session.status !== 'staged') {
    throw new Error(
      `SIE_PARSE_SESSION_NOT_STAGED: sessionen har status ${session.status}`,
    )
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    throw new Error('SIE_PARSE_SESSION_EXPIRED')
  }

  const { data: archived, error: downloadError } = await input.supabase.storage
    .from('sie-files')
    .download(session.storage_path)
  if (downloadError || !archived) {
    throw new Error(
      `SIE_PARSE_SESSION_ARCHIVE_MISSING: ${downloadError?.message ?? 'originalfilen saknas'}`,
    )
  }

  const arrayBuffer = await archived.arrayBuffer()
  const rawBytes = new Uint8Array(arrayBuffer)
  const archiveHash = await calculateSIEArchiveHash(rawBytes)
  if (archiveHash !== session.archive_hash) {
    throw new Error('SIE_PARSE_SESSION_ARCHIVE_HASH_MISMATCH')
  }
  const encoding = detectEncoding(arrayBuffer)
  const content = decodeBuffer(arrayBuffer, encoding)
  const actualHash = await calculateFileHash(content)
  if (actualHash !== session.file_hash) {
    throw new Error('SIE_PARSE_SESSION_HASH_MISMATCH')
  }

  return { session, rawBytes, content }
}
