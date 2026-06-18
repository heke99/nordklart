'use client'

import { createContext, useContext } from 'react'
import type { Company, CompanyRole, Team } from '@/types'

interface CompanyContextValue {
  company: Company | null
  role: CompanyRole | null
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
