'use client'

import Link from 'next/link'
import { Building2, ShieldCheck, UsersRound } from 'lucide-react'
import CompanySwitcher from '@/components/dashboard/CompanySwitcher'
import { useCompany } from '@/contexts/CompanyContext'

/**
 * Keeps accounting company selection separate from the broader workspace menu.
 * A user can be a company owner, agency user and platform admin simultaneously.
 */
export default function WorkspaceSwitcher() {
  const {
    company,
    workspaceType,
    canManageAgency,
    canManagePlatform,
  } = useCompany()

  return (
    <div className="space-y-2">
      <CompanySwitcher />
      {(canManageAgency || canManagePlatform) ? (
        <div className="border-t pt-2">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Arbetsytor
          </p>
          <div className="space-y-1">
            {company ? (
              <Link
                href="/app"
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition ${
                  workspaceType === 'company'
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                <Building2 className="h-3.5 w-3.5" />
                Företag
              </Link>
            ) : null}
            {canManageAgency ? (
              <Link
                href="/agency"
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition ${
                  workspaceType === 'agency'
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                <UsersRound className="h-3.5 w-3.5" />
                Redovisningsbyrå
              </Link>
            ) : null}
            {canManagePlatform ? (
              <Link
                href="/platform"
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition ${
                  workspaceType === 'platform'
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Nordklart Plattform
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
