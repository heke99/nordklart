'use client'

import { Badge } from '@/components/ui/badge'
import type { CompanyRegistryCompany } from './types'

export function CompanyRegistryResultCard({ company }: { company: CompanyRegistryCompany | null }) {
  if (!company) return null

  const statusLabel = company.registryStatus === 'active'
    ? 'Aktiv'
    : company.registryStatus === 'manual_review'
      ? 'Kontroll behövs'
      : 'Avregistrerad'

  return (
    <div className="rounded-lg border bg-muted/20 p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-foreground">{company.companyName}</p>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {[company.organizationNumber, company.legalForm].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Badge variant={company.registryStatus === 'ceased' ? 'destructive' : 'secondary'} className="font-normal">
          {statusLabel}
        </Badge>
      </div>
      {company.address ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {[
            company.address.street,
            [company.address.postalCode, company.address.city].filter(Boolean).join(' '),
          ].filter(Boolean).join(', ')}
        </p>
      ) : null}
      {Array.isArray(company.sniCodes) && company.sniCodes.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          SNI: {company.sniCodes.slice(0, 2).map((s) => `${s.code} ${s.name}`).join(' · ')}
        </p>
      ) : null}
    </div>
  )
}
