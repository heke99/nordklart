'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import type { CompanySettings } from '@/types'

export function useSettings() {
  const router = useRouter()
  const { company } = useCompany()
  // Extracted so the memoized callback depends on the primitive id — the
  // compiler otherwise infers the whole `company` object as the dependency.
  const companyId = company?.id
  const [settings, setSettings] = useState<CompanySettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const fetchSettings = useCallback(async () => {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }

    if (companyId) {
      const { data } = await supabase
        .from('company_settings')
        .select('*')
        .eq('company_id', companyId)
        .single()
      setSettings(data)
    }

    setIsLoading(false)
  }, [companyId, router])

  useEffect(() => {
    // Defer to the next macrotask so the synchronous setState inside
    // fetchSettings does not run directly within the effect body.
    const timer = setTimeout(() => {
      fetchSettings()
    }, 0)
    return () => clearTimeout(timer)
  }, [fetchSettings])

  const updateSettings = useCallback((updates: Partial<CompanySettings>) => {
    setSettings(prev => prev ? { ...prev, ...updates } as CompanySettings : null)
  }, [])

  return { settings, isLoading, updateSettings, refetch: fetchSettings }
}
