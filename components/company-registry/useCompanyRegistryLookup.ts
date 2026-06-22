'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import type { CompanyRegistryCompany, CompanyRegistryLookupResponse, CompanyRegistryLookupStatus } from './types'

type LookupState = {
  status: CompanyRegistryLookupStatus
  company: CompanyRegistryCompany | null
  lookupToken: string | null
  message: string | null
}

type UseCompanyRegistryLookupOptions = {
  endpoint?: string
  debounceMs?: number
  enabled?: boolean
}

const DEFAULT_ENDPOINT = '/api/public/company-lookup'

export function useCompanyRegistryLookup({
  endpoint = DEFAULT_ENDPOINT,
  debounceMs = 500,
  enabled = true,
}: UseCompanyRegistryLookupOptions = {}) {
  const [state, setState] = useState<LookupState>({
    status: 'idle',
    company: null,
    lookupToken: null,
    message: null,
  })
  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reset = useCallback(() => {
    abortRef.current?.abort()
    if (timerRef.current) clearTimeout(timerRef.current)
    setState({ status: 'idle', company: null, lookupToken: null, message: null })
  }, [])

  const lookupNow = useCallback(async (rawOrgNumber: string) => {
    const organizationNumber = normalizeOrgNumber(rawOrgNumber)
    abortRef.current?.abort()

    if (!enabled) {
      setState({ status: 'idle', company: null, lookupToken: null, message: null })
      return null
    }

    if (!organizationNumber) {
      setState({
        status: rawOrgNumber.trim() ? 'invalid' : 'idle',
        company: null,
        lookupToken: null,
        message: rawOrgNumber.trim() ? 'Kontrollera organisationsnumret.' : null,
      })
      return null
    }

    const controller = new AbortController()
    abortRef.current = controller
    setState({ status: 'searching', company: null, lookupToken: null, message: 'Söker hos Bolagsverket…' })

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationNumber }),
        signal: controller.signal,
      })

      const result = await response.json().catch(() => ({})) as CompanyRegistryLookupResponse
      if (controller.signal.aborted) return null

      if (!response.ok) {
        setState({
          status: 'error',
          company: null,
          lookupToken: null,
          message: result.message ?? 'Kunde inte kontrollera företaget just nu. Du kan fylla i uppgifterna manuellt.',
        })
        return null
      }

      if (!result.available) {
        setState({
          status: 'unavailable',
          company: null,
          lookupToken: null,
          message: result.message ?? 'Bolagsverket kunde inte nås just nu. Fyll i uppgifterna manuellt och försök uppdatera senare.',
        })
        return null
      }

      if (!result.found || !result.company) {
        setState({
          status: 'not_found',
          company: null,
          lookupToken: null,
          message: result.message ?? 'Vi hittade inte företaget i Bolagsverket. Kontrollera numret eller fyll i manuellt.',
        })
        return null
      }

      setState({
        status: 'found',
        company: result.company,
        lookupToken: result.lookupToken ?? null,
        message: result.company.registryStatus === 'manual_review'
          ? 'Uppgifter hittades, men företaget behöver kontrolleras manuellt.'
          : result.company.registryStatus === 'ceased'
            ? 'Företaget är avregistrerat enligt registret.'
            : 'Uppgifter hämtades från Bolagsverket.',
      })
      return result
    } catch (error) {
      if ((error as Error).name === 'AbortError') return null
      setState({
        status: 'error',
        company: null,
        lookupToken: null,
        message: 'Kunde inte kontrollera företaget just nu. Du kan fylla i uppgifterna manuellt.',
      })
      return null
    }
  }, [enabled, endpoint])

  const lookup = useCallback((rawOrgNumber: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      void lookupNow(rawOrgNumber)
    }, debounceMs)
  }, [debounceMs, lookupNow])

  useEffect(() => () => {
    abortRef.current?.abort()
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  return { ...state, lookup, lookupNow, reset }
}
