import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityType } from '@/types'

/**
 * Canonical legal-form reader (revision item B13).
 *
 * `companies.entity_type` is the single source of truth (NOT NULL with a
 * CHECK constraint in the schema; a database trigger keeps the legacy
 * `company_settings.entity_type` mirror in sync). Every module — bokslut,
 * årsredovisning, skatt, kontoval, regelverk, rapporter, onboarding — must
 * read through this helper.
 *
 * There is deliberately NO fallback to 'aktiebolag': a missing or unknown
 * value throws, and callers must block the operation with a clear
 * explanation instead of silently assuming AB.
 */

export class EntityTypeMissingError extends Error {
  readonly code = 'ENTITY_TYPE_MISSING'
  constructor(companyId: string) {
    super(
      `Företagsform saknas för företaget (${companyId}). Ange företagsform under företagsinställningar innan du fortsätter.`
    )
    this.name = 'EntityTypeMissingError'
  }
}

const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set(['enskild_firma', 'aktiebolag'])

export async function getCompanyEntityType(
  supabase: SupabaseClient,
  companyId: string
): Promise<EntityType> {
  const { data, error } = await supabase
    .from('companies')
    .select('entity_type')
    .eq('id', companyId)
    .single()

  if (error) {
    throw new Error(`Företagsformen kunde inte läsas: ${error.message}`)
  }

  const entityType = data?.entity_type
  if (!entityType || !VALID_ENTITY_TYPES.has(entityType)) {
    throw new EntityTypeMissingError(companyId)
  }

  return entityType as EntityType
}
