'use client'

import { createContext, useContext } from 'react'
import type { Company, CompanyRole, Team } from '@/types'

interface CompanyContextValue {
  company: Company | null
  role: CompanyRole | null
  /**
   * Server-resolved effective write capability for the active company
   * (resolve_company_access → canWrite). Unlike the legacy role check this
   * accounts for agency reviewer/read-only staff and `active_limited`
   * memberships — keep UI gating in sync with the API/RLS layers.
   */
  canWrite: boolean
  companies: { company: Company; role: CompanyRole }[]
  isTeamMember: boolean
  team: Team | null
  isSandbox: boolean
  workspaceType: 'company' | 'agency' | 'platform'
  agencyId: string | null
  canManageAgency: boolean
  canManagePlatform: boolean
}

const CompanyContext = createContext<CompanyContextValue | null>(null)

export function CompanyProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: CompanyContextValue
}) {
  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
}

export function useCompany() {
  const ctx = useContext(CompanyContext)
  if (!ctx) throw new Error('useCompany must be used within CompanyProvider')
  return ctx
}

export function useCompanyOptional() {
  return useContext(CompanyContext)
}
