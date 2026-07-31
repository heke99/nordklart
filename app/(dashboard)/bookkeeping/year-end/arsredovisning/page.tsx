'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { PageHeader } from '@/components/ui/page-header'
import {
  ArrowLeft,
  FileDown,
  Plus,
  ExternalLink,
  Loader2,
  Save,
  CheckCircle2,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import type { ArsredovisningData } from '@/lib/bokslut/arsredovisning/types'
import type { SignatureRequest } from '@/lib/bokslut/arsredovisning/signature-service'
import { ConsentSigningDialog } from '@/components/bankid/ConsentSigningDialog'
import { getYearEndApiErrorMessage } from '@/lib/year-end/api-error'

type PresentationReclassification = {
  id: string
  account_number: string
  source_concept: string
  target_concept: string
  original_presentation?: string
  target_presentation: string
  amount: number
  reason: string
  created_at: string
}

type AnnualReportLifecycle = {
  ledger_locked: boolean
  annual_report_locked: boolean
  status: string
  preflight: {
    preflight_status: 'passed' | 'failed'
    blocking_issue_count: number
    warning_count: number
    issues: Array<{
      code: string
      severity: 'blocking' | 'warning'
      scope: string
      message: string
      requires_reopen: boolean
      actions: Array<{ id: string; label: string }>
    }>
  }
  final_pdf_url: string | null
  final_ixbrl_url: string | null
  presentation_reclassifications: PresentationReclassification[]
}

type FiscalPeriodReopenRequest = {
  id: string
  status: 'requested' | 'approved' | 'reopening' | 'reopened' | 'rejected' | 'blocked' | 'failed'
  reason: string
  requested_changes: string[]
  designated_approver_name: string
  error_code?: string | null
  error_message?: string | null
  requested_at: string
  reopened_at?: string | null
}

export default function ArsredovisningPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const periodId = searchParams.get('period')
  const companyId = searchParams.get('company_id')
  const companySuffix = companyId ? `?company_id=${encodeURIComponent(companyId)}` : ''
  const { toast } = useToast()

  const [data, setData] = useState<ArsredovisningData | null>(null)
  const [signatures, setSignatures] = useState<SignatureRequest[]>([])
  const [bankIdSignFor, setBankIdSignFor] = useState<SignatureRequest | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lifecycle, setLifecycle] = useState<AnnualReportLifecycle | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  const [creatingVersion, setCreatingVersion] = useState(false)
  const [reopenRequests, setReopenRequests] = useState<FiscalPeriodReopenRequest[]>([])
  const [reopenReason, setReopenReason] = useState('')
  const [reopenChanges, setReopenChanges] = useState('')
  const [reopenApprover, setReopenApprover] = useState('')
  const [annualReportAlreadyFiled, setAnnualReportAlreadyFiled] = useState(false)
  const [taxReturnAlreadyFiled, setTaxReturnAlreadyFiled] = useState(false)
  const [submittingReopen, setSubmittingReopen] = useState(false)
  const [approvingReopenId, setApprovingReopenId] = useState<string | null>(null)
  const [reclassAccount, setReclassAccount] = useState('')
  const [reclassTargetConcept, setReclassTargetConcept] = useState('OvrigaFordringarKortfristiga')
  const [reclassTargetLabel, setReclassTargetLabel] = useState('Övriga kortfristiga fordringar')
  const [reclassAmount, setReclassAmount] = useState('')
  const [reclassReason, setReclassReason] = useState('')
  const [savingReclassification, setSavingReclassification] = useState(false)
  const [revokingReclassificationId, setRevokingReclassificationId] = useState<string | null>(null)

  // Editable narrative fields — persisted to arsredovisning_narratives so
  // the PDF always reflects the latest saved version and a refresh / new
  // user picks up the same content.
  const [description, setDescription] = useState('')
  const [importantEvents, setImportantEvents] = useState('')
  const [eventsAfterBalanceSheet, setEventsAfterBalanceSheet] = useState('')
  const [reportLegalName, setReportLegalName] = useState('')
  const [reportRegisteredOffice, setReportRegisteredOffice] = useState('')
  const [priorLegalName, setPriorLegalName] = useState('')
  const [resultatdisposition, setResultatdisposition] = useState('')
  const [savedDescription, setSavedDescription] = useState('')
  const [savedImportantEvents, setSavedImportantEvents] = useState('')
  const [savedEventsAfterBalanceSheet, setSavedEventsAfterBalanceSheet] = useState('')
  const [savedReportLegalName, setSavedReportLegalName] = useState('')
  const [savedReportRegisteredOffice, setSavedReportRegisteredOffice] = useState('')
  const [savedPriorLegalName, setSavedPriorLegalName] = useState('')
  const [savedResultatdisposition, setSavedResultatdisposition] = useState('')
  const [agmDate, setAgmDate] = useState('')
  const [savedAgmDate, setSavedAgmDate] = useState('')
  const [agmAccountsAdopted, setAgmAccountsAdopted] = useState(false)
  const [savedAgmAccountsAdopted, setSavedAgmAccountsAdopted] = useState(false)
  const [agmDecision, setAgmDecision] = useState('')
  const [savedAgmDecision, setSavedAgmDecision] = useState('')
  const [certificateSignerName, setCertificateSignerName] = useState('')
  const [savedCertificateSignerName, setSavedCertificateSignerName] = useState('')
  const [certificateSignerRole, setCertificateSignerRole] = useState('Styrelseledamot')
  const [savedCertificateSignerRole, setSavedCertificateSignerRole] = useState('Styrelseledamot')
  const [certificateSignedAt, setCertificateSignedAt] = useState('')
  const [savedCertificateSignedAt, setSavedCertificateSignedAt] = useState('')
  // Disclosure fields per ÅRL 5:13-15 § + BFNAR koncernförhållanden.
  // Persisted via the same POST endpoint as the förvaltningsberättelse text.
  const [longTermDebt, setLongTermDebt] = useState('')
  const [savedLongTermDebt, setSavedLongTermDebt] = useState('')
  const [securitiesPledged, setSecuritiesPledged] = useState('')
  const [savedSecuritiesPledged, setSavedSecuritiesPledged] = useState('')
  const [contingentLiabilities, setContingentLiabilities] = useState('')
  const [savedContingentLiabilities, setSavedContingentLiabilities] = useState('')
  const [parentName, setParentName] = useState('')
  const [savedParentName, setSavedParentName] = useState('')
  const [parentOrgNr, setParentOrgNr] = useState('')
  const [savedParentOrgNr, setSavedParentOrgNr] = useState('')
  const [parentCity, setParentCity] = useState('')
  const [savedParentCity, setSavedParentCity] = useState('')
  const [savingNarrative, setSavingNarrative] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Add-signer form
  const [signerName, setSignerName] = useState('')
  const [signerRole, setSignerRole] = useState('Styrelseledamot')

  const refreshAnnualReportState = useCallback(async () => {
    if (!periodId) return
    const response = await fetch(
      `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning${companySuffix}`,
    )
    if (!response.ok) return
    const body = await response.json()
    if (body?.data) setData(body.data as ArsredovisningData)
    setLifecycle((body?.lifecycle ?? null) as AnnualReportLifecycle | null)
  }, [periodId, companySuffix])

  useEffect(() => {
    if (!periodId) return
    let cancelled = false
    Promise.all([
      fetch(`/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning${companySuffix}`).then((r) => r.json()),
      fetch(`/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/signatures${companySuffix}`).then((r) =>
        r.json(),
      ),
      fetch(`/api/bookkeeping/fiscal-periods/${periodId}/reopen${companySuffix}`).then((r) => r.json()),
    ])
      .then(([arBody, sigBody, reopenBody]) => {
        if (cancelled) return
        if (arBody?.error) {
          setError(arBody.error.message ?? 'Kunde inte hämta årsredovisning')
          return
        }
        const d = arBody.data as ArsredovisningData
        setData(d)
        setLifecycle((arBody.lifecycle ?? null) as AnnualReportLifecycle | null)
        // buildArsredovisningData merges persisted narrative + boilerplate,
        // so the values here are whatever the user will see in the PDF
        // unless they edit. Track both "current draft" and "last saved" so
        // we can disable Spara when there's nothing pending.
        setDescription(d.forvaltningsberattelse.description)
        setImportantEvents(d.forvaltningsberattelse.important_events)
        setEventsAfterBalanceSheet(d.forvaltningsberattelse.events_after_balance_sheet ?? '')
        setReportLegalName(d.company.name)
        setReportRegisteredOffice(d.company.city ?? '')
        setPriorLegalName(d.company.prior_legal_name ?? '')
        setResultatdisposition(d.forvaltningsberattelse.resultatdisposition)
        setAgmDate(d.forvaltningsberattelse.agm_date ?? '')
        setSavedDescription(d.forvaltningsberattelse.description)
        setSavedImportantEvents(d.forvaltningsberattelse.important_events)
        setSavedEventsAfterBalanceSheet(d.forvaltningsberattelse.events_after_balance_sheet ?? '')
        setSavedReportLegalName(d.company.name)
        setSavedReportRegisteredOffice(d.company.city ?? '')
        setSavedPriorLegalName(d.company.prior_legal_name ?? '')
        setSavedResultatdisposition(d.forvaltningsberattelse.resultatdisposition)
        setSavedAgmDate(d.forvaltningsberattelse.agm_date ?? '')
        const adopted = d.forvaltningsberattelse.agm_accounts_adopted === true
        const decision = d.forvaltningsberattelse.agm_result_disposition_decision ?? ''
        const certName = d.forvaltningsberattelse.certificate_signer_name ?? ''
        const certRole = d.forvaltningsberattelse.certificate_signer_role ?? 'Styrelseledamot'
        const certDate = d.forvaltningsberattelse.certificate_signed_at ?? ''
        setAgmAccountsAdopted(adopted)
        setSavedAgmAccountsAdopted(adopted)
        setAgmDecision(decision)
        setSavedAgmDecision(decision)
        setCertificateSignerName(certName)
        setSavedCertificateSignerName(certName)
        setCertificateSignerRole(certRole)
        setSavedCertificateSignerRole(certRole)
        setCertificateSignedAt(certDate)
        setSavedCertificateSignedAt(certDate)
        const ltd = d.disclosures.long_term_debt_over_five_years
        const ltdStr = ltd != null ? String(ltd) : ''
        setLongTermDebt(ltdStr)
        setSavedLongTermDebt(ltdStr)
        setSecuritiesPledged(d.disclosures.securities_pledged ?? '')
        setSavedSecuritiesPledged(d.disclosures.securities_pledged ?? '')
        setContingentLiabilities(d.disclosures.contingent_liabilities ?? '')
        setSavedContingentLiabilities(d.disclosures.contingent_liabilities ?? '')
        setParentName(d.disclosures.parent_company_name ?? '')
        setSavedParentName(d.disclosures.parent_company_name ?? '')
        setParentOrgNr(d.disclosures.parent_company_org_number ?? '')
        setSavedParentOrgNr(d.disclosures.parent_company_org_number ?? '')
        setParentCity(d.disclosures.parent_company_city ?? '')
        setSavedParentCity(d.disclosures.parent_company_city ?? '')
        setSignatures((sigBody.data ?? []) as SignatureRequest[])
        setReopenRequests((reopenBody?.data ?? []) as FiscalPeriodReopenRequest[])
      })
      .catch(() => {
        if (!cancelled) setError('Kunde inte hämta årsredovisning')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [periodId, companySuffix])

  const hasUnsavedNarrative =
    description !== savedDescription ||
    importantEvents !== savedImportantEvents ||
    eventsAfterBalanceSheet !== savedEventsAfterBalanceSheet ||
    reportLegalName !== savedReportLegalName ||
    reportRegisteredOffice !== savedReportRegisteredOffice ||
    priorLegalName !== savedPriorLegalName ||
    resultatdisposition !== savedResultatdisposition ||
    agmDate !== savedAgmDate ||
    agmAccountsAdopted !== savedAgmAccountsAdopted ||
    agmDecision !== savedAgmDecision ||
    certificateSignerName !== savedCertificateSignerName ||
    certificateSignerRole !== savedCertificateSignerRole ||
    certificateSignedAt !== savedCertificateSignedAt ||
    longTermDebt !== savedLongTermDebt ||
    securitiesPledged !== savedSecuritiesPledged ||
    contingentLiabilities !== savedContingentLiabilities ||
    parentName !== savedParentName ||
    parentOrgNr !== savedParentOrgNr ||
    parentCity !== savedParentCity

  const handleSaveNarrative = useCallback(async () => {
    if (!periodId) return
    // Parse the long-term debt input; empty string and zero both clear the
    // override (the note then falls back to the "Inga." default). Reject
    // non-numeric input with a toast so the API doesn't return a 400.
    let longTermDebtParsed: number | null = null
    if (longTermDebt.trim()) {
      const parsed = Number(longTermDebt.replace(',', '.'))
      if (!Number.isFinite(parsed) || parsed < 0) {
        toast({
          title: 'Ogiltigt belopp',
          description:
            'Långfristiga skulder förfallande efter mer än fem år måste vara ett positivt tal (eller lämnas tomt).',
          variant: 'destructive',
        })
        return
      }
      longTermDebtParsed = parsed
    }
    setSavingNarrative(true)
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/narrative${companySuffix}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description,
            important_events: importantEvents,
            events_after_balance_sheet: eventsAfterBalanceSheet,
            report_legal_name: reportLegalName.trim() || null,
            report_registered_office: reportRegisteredOffice.trim() || null,
            prior_legal_name: priorLegalName.trim() || null,
            resultatdisposition,
            agm_date: agmDate || null,
            agm_accounts_adopted: agmAccountsAdopted,
            agm_result_disposition_decision: agmDecision.trim() || null,
            certificate_signer_name: certificateSignerName.trim() || null,
            certificate_signer_role: certificateSignerRole.trim() || null,
            certificate_signed_at: certificateSignedAt || null,
            long_term_debt_over_five_years: longTermDebtParsed,
            securities_pledged: securitiesPledged.trim() || null,
            contingent_liabilities: contingentLiabilities.trim() || null,
            parent_company_name: parentName.trim() || null,
            parent_company_org_number: parentOrgNr.trim() || null,
            parent_company_city: parentCity.trim() || null,
          }),
        },
      )
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte spara texten',
          description: getYearEndApiErrorMessage(body, 'Åtgärden misslyckades.', res.status),
          variant: 'destructive',
        })
        return
      }
      setSavedDescription(description)
      setSavedImportantEvents(importantEvents)
      setSavedEventsAfterBalanceSheet(eventsAfterBalanceSheet)
      setSavedReportLegalName(reportLegalName)
      setSavedReportRegisteredOffice(reportRegisteredOffice)
      setSavedPriorLegalName(priorLegalName)
      setSavedResultatdisposition(resultatdisposition)
      setSavedAgmDate(agmDate)
      setSavedAgmAccountsAdopted(agmAccountsAdopted)
      setSavedAgmDecision(agmDecision)
      setSavedCertificateSignerName(certificateSignerName)
      setSavedCertificateSignerRole(certificateSignerRole)
      setSavedCertificateSignedAt(certificateSignedAt)
      setSavedLongTermDebt(longTermDebt)
      setSavedSecuritiesPledged(securitiesPledged)
      setSavedContingentLiabilities(contingentLiabilities)
      setSavedParentName(parentName)
      setSavedParentOrgNr(parentOrgNr)
      setSavedParentCity(parentCity)
      setSavedAt(Date.now())
      await refreshAnnualReportState()
    } catch (err) {
      toast({
        title: 'Kunde inte spara texten',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setSavingNarrative(false)
    }
  }, [
    periodId,
    companySuffix,
    description,
    importantEvents,
    eventsAfterBalanceSheet,
    reportLegalName,
    reportRegisteredOffice,
    priorLegalName,
    resultatdisposition,
    agmDate,
    agmAccountsAdopted,
    agmDecision,
    certificateSignerName,
    certificateSignerRole,
    certificateSignedAt,
    longTermDebt,
    securitiesPledged,
    contingentLiabilities,
    parentName,
    parentOrgNr,
    parentCity,
    refreshAnnualReportState,
    toast,
  ])

  const handleMarkSigned = useCallback(
    async (signatureId: string) => {
      if (!periodId) return
      const now = new Date()
      const localToday = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('-')
      const signedAt = window.prompt(
        'Ange den verkliga underskriftsdagen (ÅÅÅÅ-MM-DD):',
        localToday,
      )?.trim()
      if (!signedAt || !/^\d{4}-\d{2}-\d{2}$/.test(signedAt)) {
        toast({
          title: 'Underskriftsdag krävs',
          description: 'Ange datum i formatet ÅÅÅÅ-MM-DD. Datumet sätts aldrig automatiskt.',
          variant: 'destructive',
        })
        return
      }
      try {
        const res = await fetch(
          `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/signatures/${signatureId}${companySuffix}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'signed', signed_at: signedAt }),
          },
        )
        const body = await res.json()
        if (!res.ok) {
          toast({
            title: 'Kunde inte markera som signerad',
            description: getYearEndApiErrorMessage(body, 'Åtgärden misslyckades.', res.status),
            variant: 'destructive',
          })
          return
        }
        setSignatures((prev) =>
          prev.map((s) => (s.id === signatureId ? (body.data as SignatureRequest) : s)),
        )
        toast({ title: 'Underskrift registrerad' })
        await refreshAnnualReportState()
      } catch (err) {
        toast({
          title: 'Kunde inte markera som signerad',
          description: err instanceof Error ? err.message : 'Okänt fel',
          variant: 'destructive',
        })
      }
    },
    [periodId, companySuffix, refreshAnnualReportState, toast],
  )

  const handleAddSigner = useCallback(async () => {
    if (!periodId || !signerName.trim()) return
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/signatures${companySuffix}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: signerRole, signer_name: signerName.trim() }),
        },
      )
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte lägga till undertecknare',
          description: getYearEndApiErrorMessage(body, 'Åtgärden misslyckades.', res.status),
          variant: 'destructive',
        })
        return
      }
      setSignatures((prev) => [...prev, body.data as SignatureRequest])
      setSignerName('')
      toast({ title: 'Undertecknare tillagd', description: `${signerRole}: ${signerName}` })
      await refreshAnnualReportState()
    } catch (err) {
      toast({
        title: 'Kunde inte lägga till undertecknare',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    }
  }, [periodId, companySuffix, signerName, signerRole, refreshAnnualReportState, toast])

  const handleFinalize = useCallback(async () => {
    if (!periodId || hasUnsavedNarrative) return
    setFinalizing(true)
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/finalize${companySuffix}`,
        { method: 'POST' },
      )
      const body = await res.json()
      if (!res.ok) {
        const preflight = body?.error?.details?.preflight
        if (preflight && lifecycle) setLifecycle({ ...lifecycle, preflight })
        toast({
          title: 'Årsredovisningen kunde inte färdigställas',
          description: getYearEndApiErrorMessage(body, 'Kontrollera blockerarna nedan.', res.status),
          variant: 'destructive',
        })
        return
      }
      toast({ title: 'Slutversion skapad och arkiverad' })
      window.location.reload()
    } catch (err) {
      toast({
        title: 'Årsredovisningen kunde inte färdigställas',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setFinalizing(false)
    }
  }, [periodId, companySuffix, hasUnsavedNarrative, lifecycle, toast])

  const handleCreateNewVersion = useCallback(async () => {
    if (!periodId) return
    const reason = window.prompt('Ange varför en ny årsredovisningsversion behövs:')?.trim()
    if (!reason || reason.length < 10) return
    setCreatingVersion(true)
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/versions${companySuffix}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        },
      )
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: 'Ny version kunde inte skapas',
          description: getYearEndApiErrorMessage(body, 'Åtgärden misslyckades.', res.status),
          variant: 'destructive',
        })
        return
      }
      toast({ title: 'Nytt redigerbart utkast skapat' })
      window.location.reload()
    } catch (err) {
      toast({
        title: 'Ny version kunde inte skapas',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setCreatingVersion(false)
    }
  }, [periodId, companySuffix, toast])

  const handleRequestReopen = useCallback(async () => {
    if (!periodId) return
    const requestedChanges = reopenChanges
      .split(/\n|,/)
      .map((value) => value.trim())
      .filter(Boolean)
    if (reopenReason.trim().length < 10 || requestedChanges.length === 0 || reopenApprover.trim().length < 2) {
      toast({
        title: 'Komplettera återöppningsbegäran',
        description: 'Ange orsak, minst en konkret ändring och vem som ska godkänna.',
        variant: 'destructive',
      })
      return
    }
    setSubmittingReopen(true)
    try {
      const response = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/reopen${companySuffix}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reason: reopenReason.trim(),
            requested_changes: requestedChanges,
            annual_report_already_filed: annualReportAlreadyFiled,
            tax_return_already_filed: taxReturnAlreadyFiled,
            designated_approver_name: reopenApprover.trim(),
          }),
        },
      )
      const body = await response.json()
      if (!response.ok && response.status !== 409) {
        toast({
          title: 'Återöppningsbegäran kunde inte sparas',
          description: getYearEndApiErrorMessage(body, 'Åtgärden misslyckades.', response.status),
          variant: 'destructive',
        })
        return
      }
      const request = body?.data as FiscalPeriodReopenRequest | undefined
      if (request) setReopenRequests((current) => [request, ...current])
      setReopenReason('')
      setReopenChanges('')
      setReopenApprover('')
      toast({
        title: request?.status === 'blocked' ? 'Särskilt rättelseflöde krävs' : 'Återöppningsbegäran skapad',
        description: request?.error_message ?? 'Begäran är sparad och kan godkännas av behörig person.',
        variant: request?.status === 'blocked' ? 'destructive' : 'default',
      })
    } catch (requestError) {
      toast({
        title: 'Återöppningsbegäran kunde inte sparas',
        description: requestError instanceof Error ? requestError.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setSubmittingReopen(false)
    }
  }, [
    periodId,
    companySuffix,
    reopenChanges,
    reopenReason,
    reopenApprover,
    annualReportAlreadyFiled,
    taxReturnAlreadyFiled,
    toast,
  ])

  const handleApproveReopen = useCallback(async (requestId: string) => {
    if (!periodId) return
    const approvalNote = window.prompt('Ange godkännandemotivering (minst 5 tecken):')?.trim()
    if (!approvalNote || approvalNote.length < 5) return
    setApprovingReopenId(requestId)
    try {
      const response = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/reopen/${requestId}/approve${companySuffix}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approval_note: approvalNote }),
        },
      )
      const body = await response.json()
      if (!response.ok) {
        toast({
          title: 'Räkenskapsåret kunde inte återöppnas',
          description: getYearEndApiErrorMessage(body, body?.data?.error_message ?? 'Åtgärden misslyckades.', response.status),
          variant: 'destructive',
        })
        return
      }
      toast({ title: 'Räkenskapsåret har återöppnats för kontrollerad rättelse' })
      window.location.reload()
    } catch (approvalError) {
      toast({
        title: 'Räkenskapsåret kunde inte återöppnas',
        description: approvalError instanceof Error ? approvalError.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setApprovingReopenId(null)
    }
  }, [periodId, companySuffix, toast])

  const handleCreateReclassification = useCallback(async () => {
    if (!periodId) return
    const amount = Number(reclassAmount.replace(',', '.'))
    if (!/^\d{4}$/.test(reclassAccount) || !Number.isFinite(amount) || amount <= 0 || reclassReason.trim().length < 10) {
      toast({
        title: 'Ofullständig omklassificering',
        description: 'Ange ett fyrsiffrigt konto, ett positivt belopp och en motivering på minst 10 tecken.',
        variant: 'destructive',
      })
      return
    }
    setSavingReclassification(true)
    try {
      const response = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/reclassifications${companySuffix}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account_number: reclassAccount,
            target_concept: reclassTargetConcept,
            target_presentation: reclassTargetLabel,
            amount,
            reason: reclassReason.trim(),
          }),
        },
      )
      const body = await response.json()
      if (!response.ok) {
        toast({
          title: 'Omklassificeringen kunde inte sparas',
          description: getYearEndApiErrorMessage(body, body?.error?.message ?? 'Åtgärden misslyckades.', response.status),
          variant: 'destructive',
        })
        return
      }
      setReclassAccount('')
      setReclassAmount('')
      setReclassReason('')
      toast({ title: 'Presentationsomklassificeringen har sparats' })
      await refreshAnnualReportState()
    } catch (reclassificationError) {
      toast({
        title: 'Omklassificeringen kunde inte sparas',
        description: reclassificationError instanceof Error ? reclassificationError.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setSavingReclassification(false)
    }
  }, [
    periodId,
    companySuffix,
    reclassAccount,
    reclassAmount,
    reclassReason,
    reclassTargetConcept,
    reclassTargetLabel,
    refreshAnnualReportState,
    toast,
  ])

  const handleRevokeReclassification = useCallback(async (id: string) => {
    if (!periodId) return
    const reason = window.prompt('Ange varför omklassificeringen återkallas (minst 10 tecken):')?.trim()
    if (!reason || reason.length < 10) return
    setRevokingReclassificationId(id)
    try {
      const response = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/reclassifications${companySuffix}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, reason }),
        },
      )
      const body = await response.json()
      if (!response.ok) {
        toast({
          title: 'Omklassificeringen kunde inte återkallas',
          description: getYearEndApiErrorMessage(body, body?.error?.message ?? 'Åtgärden misslyckades.', response.status),
          variant: 'destructive',
        })
        return
      }
      toast({ title: 'Omklassificeringen har återkallats' })
      await refreshAnnualReportState()
    } finally {
      setRevokingReclassificationId(null)
    }
  }, [periodId, companySuffix, refreshAnnualReportState, toast])

  const focusIssueAction = useCallback((actionId: string, requiresReopen: boolean) => {
    const target = requiresReopen || actionId === 'request_reopen'
      ? 'controlled-reopen'
      : actionId === 'manage_signatures'
        ? 'annual-report-signatures'
        : ['edit_narrative', 'complete_agm', 'complete_certificate'].includes(actionId)
          ? 'annual-report-narrative'
          : ['create_presentation_reclassification', 'review_reclassifications'].includes(actionId)
            ? 'annual-report-reclassifications'
            : null
    if (target) {
      document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    if (['open_year_end', 'show_balance_analysis', 'show_account_analysis', 'review_equity'].includes(actionId)) {
      router.push(
        `/bookkeeping/year-end?period=${encodeURIComponent(periodId ?? '')}${
          companyId ? `&company_id=${encodeURIComponent(companyId)}` : ''
        }`,
      )
      return
    }
    if (actionId === 'download_k3_draft' && periodId) {
      window.open(
        `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/pdf${companySuffix}`,
        '_blank',
        'noopener,noreferrer',
      )
      return
    }
    if (['import_prior_annual_report', 'enter_verified_comparatives', 'complete_multi_year_overview'].includes(actionId)) {
      toast({
        title: 'Verifierade jämförelsetal krävs',
        description: 'Registrera föregående fastställda årsredovisning via jämförelseimporten innan slutversion skapas.',
      })
      return
    }
    void refreshAnnualReportState()
    toast({ title: 'Kontrollen har körts om' })
  }, [companyId, companySuffix, periodId, refreshAnnualReportState, router, toast])

  if (!periodId) {
    return (
      <div className="space-y-8">
        <PageHeader
          title="Årsredovisning"
          description="Förhandsgranska och ladda ner årsredovisningen för valt räkenskapsår."
        />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Välj räkenskapsår</CardTitle>
            <p className="text-sm text-muted-foreground">
              Välj det räkenskapsår du vill se årsredovisningen för. Du kan
              förhandsgranska och ladda ner PDF-utkastet utan att stänga året — det
              fullständiga bokslutet görs sedan via{' '}
              <Link href={`/bookkeeping/year-end${companySuffix}`} className="text-foreground underline underline-offset-4 decoration-muted-foreground/40 hover:decoration-foreground">
                Bokslut
              </Link>
              .
            </p>
          </CardHeader>
          <CardContent>
            <FiscalYearSelector
              companyId={companyId}
              value={null}
              onChange={(id) => {
                if (id) {
                  router.replace(
                    `/bookkeeping/year-end/arsredovisning?period=${encodeURIComponent(id)}${
                      companyId ? `&company_id=${encodeURIComponent(companyId)}` : ''
                    }`,
                  )
                }
              }}
              includeAllOption={false}
              hideFuturePeriods
              label={null}
            />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <PageHeader title="Årsredovisning" />
        <Card>
          <CardContent className="p-6 space-y-3">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-32 w-full" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="space-y-8">
        <PageHeader title="Årsredovisning" />
        <Card>
          <CardContent className="p-6 text-destructive">
            {error ?? 'Kunde inte hämta data'}
          </CardContent>
        </Card>
      </div>
    )
  }

  // PDF route reads persisted narrative from the new arsredovisning_narratives
  // table. The save button below writes overrides; the URL stays clean.
  const pdfUrl = `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/pdf${companySuffix}`

  return (
    <div className="space-y-8">
      <PageHeader
        title={`Årsredovisning ${data.fiscal_period.name}`}
        description={
          data.company.org_number
            ? `${data.company.name} · ${data.company.org_number}`
            : data.company.name
        }
        action={
          <Button variant="outline" asChild>
            <Link
              href={`/bookkeeping/year-end?period=${encodeURIComponent(periodId)}${
                companyId ? `&company_id=${encodeURIComponent(companyId)}` : ''
              }`}
            >
              <ArrowLeft className="mr-2 h-4 w-4" /> Tillbaka till bokslut
            </Link>
          </Button>
        }
      />

      {data.accounting_framework === 'k3' && (
        <Card>
          <CardContent className="p-4 text-sm">
            <p className="font-medium">Årsredovisning enligt K3 (BFNAR 2012:1)</p>
            <p className="text-muted-foreground mt-1">
              Dokumentet innehåller kassaflödesanalys, förändring av eget kapital och
              utökade noter (uppskjuten skatt, redovisningsprinciper, materiella
              anläggningstillgångar) — krav som följer K3 men inte K2.
            </p>
          </CardContent>
        </Card>
      )}

      <Card id="annual-report-narrative">
        <CardHeader>
          <CardTitle className="text-base">Förvaltningsberättelse — narrativ</CardTitle>
          <p className="text-sm text-muted-foreground">
            Texten nedan visas i PDF:en. Klicka på <strong>Spara texten</strong> nedan
            för att behålla ändringarna mellan sessioner.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {lifecycle?.annual_report_locked && (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              Slutversionen är skrivskyddad. Välj <strong>Skapa ny version</strong> för
              att redigera dokumentuppgifter utan att öppna huvudboken.
            </div>
          )}
          <fieldset disabled={lifecycle?.annual_report_locked} className="space-y-4 disabled:opacity-70">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ar-legal-name">Juridiskt företagsnamn i årsredovisningen</Label>
              <Input
                id="ar-legal-name"
                value={reportLegalName}
                onChange={(e) => setReportLegalName(e.target.value)}
                placeholder="Exempel: Gridex EL AB"
              />
              <p className="text-xs text-muted-foreground">
                Dokumentuppgift. Ändrar inte företagsregistret eller huvudboken.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ar-registered-office">Säte</Label>
              <Input
                id="ar-registered-office"
                value={reportRegisteredOffice}
                onChange={(e) => setReportRegisteredOffice(e.target.value)}
                placeholder="Exempel: Linköping"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ar-description">Verksamhetsbeskrivning</Label>
            <Textarea
              id="ar-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ar-events">Väsentliga händelser</Label>
            <Textarea
              id="ar-events"
              value={importantEvents}
              onChange={(e) => setImportantEvents(e.target.value)}
              rows={4}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ar-after-balance">Händelser efter balansdagen</Label>
            <Textarea
              id="ar-after-balance"
              value={eventsAfterBalanceSheet}
              onChange={(e) => setEventsAfterBalanceSheet(e.target.value)}
              rows={3}
              placeholder="Exempel: Bolaget ändrade under 2026 företagsnamn från Div3rsa AB till Gridex EL AB."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ar-prior-name">Tidigare juridiskt företagsnamn</Label>
            <Input
              id="ar-prior-name"
              value={priorLegalName}
              onChange={(e) => setPriorLegalName(e.target.value)}
              placeholder="Exempel: Div3rsa AB"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ar-rd">Resultatdisposition</Label>
            <Textarea
              id="ar-rd"
              value={resultatdisposition}
              onChange={(e) => setResultatdisposition(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ar-agm-date">Datum för årsstämma</Label>
            <Input
              id="ar-agm-date"
              type="date"
              value={agmDate}
              onChange={(e) => setAgmDate(e.target.value)}
              className="max-w-[220px]"
            />
            <p className="text-xs text-muted-foreground">
              Datum då årsstämman fastställde årsredovisningen — fyller i datumraden på
              fastställelseintyget i PDF:en (krävs för inlämning till Bolagsverket).
            </p>
          </div>

          <div className="space-y-3 rounded-md border border-border p-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={agmAccountsAdopted}
                onChange={(e) => setAgmAccountsAdopted(e.target.checked)}
              />
              Årsstämman har fastställt resultat- och balansräkningen
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="ar-agm-decision">Årsstämmans beslut om resultatdisposition</Label>
              <Textarea
                id="ar-agm-decision"
                value={agmDecision}
                onChange={(e) => setAgmDecision(e.target.value)}
                rows={2}
                placeholder="Resultatet disponeras enligt styrelsens förslag."
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="ar-cert-name">Fastställelseintyg — namn</Label>
                <Input
                  id="ar-cert-name"
                  value={certificateSignerName}
                  onChange={(e) => setCertificateSignerName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ar-cert-role">Roll</Label>
                <Input
                  id="ar-cert-role"
                  value={certificateSignerRole}
                  onChange={(e) => setCertificateSignerRole(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ar-cert-date">Signeringsdatum</Label>
                <Input
                  id="ar-cert-date"
                  type="date"
                  value={certificateSignedAt}
                  onChange={(e) => setCertificateSignedAt(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-border space-y-4">
            <div>
              <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                Lagstadgade upplysningar
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                Noter som krävs enligt ÅRL men inte kan härledas automatiskt. Tomma
                fält visas som &quot;Inga.&quot; i PDF:en.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ar-ltd">
                Långfristiga skulder förfallande efter mer än fem år (kr)
              </Label>
              <Input
                id="ar-ltd"
                type="text"
                inputMode="decimal"
                value={longTermDebt}
                onChange={(e) => setLongTermDebt(e.target.value)}
                placeholder="0"
                className="max-w-[220px] tabular-nums"
              />
              <p className="text-xs text-muted-foreground">
                ÅRL 5:13 §. Lämna tomt om inga skulder förfaller senare än fem år.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ar-securities">Ställda säkerheter</Label>
              <Textarea
                id="ar-securities"
                value={securitiesPledged}
                onChange={(e) => setSecuritiesPledged(e.target.value)}
                rows={2}
                placeholder="t.ex. Företagsinteckning 500 000 kr som säkerhet för bankkredit."
              />
              <p className="text-xs text-muted-foreground">ÅRL 5:14 §.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ar-contingent">Eventualförpliktelser</Label>
              <Textarea
                id="ar-contingent"
                value={contingentLiabilities}
                onChange={(e) => setContingentLiabilities(e.target.value)}
                rows={2}
                placeholder="t.ex. Borgensåtagande för dotterbolags krediter 200 000 kr."
              />
              <p className="text-xs text-muted-foreground">ÅRL 5:15 §.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ar-parent-name">
                Moderföretag — namn (om koncerntillhörighet)
              </Label>
              <Input
                id="ar-parent-name"
                value={parentName}
                onChange={(e) => setParentName(e.target.value)}
                placeholder="t.ex. AB Koncernholding"
              />
              <p className="text-xs text-muted-foreground">
                BFNAR 2016:10 kap. 19 / BFNAR 2012:1 kap. 8. Lämna tomt om bolaget
                inte ingår i en koncern — noten utelämnas då.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ar-parent-orgnr">Moderföretagets org.nr</Label>
                <Input
                  id="ar-parent-orgnr"
                  value={parentOrgNr}
                  onChange={(e) => setParentOrgNr(e.target.value)}
                  placeholder="556677-8899"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ar-parent-city">Moderföretagets säte</Label>
                <Input
                  id="ar-parent-city"
                  value={parentCity}
                  onChange={(e) => setParentCity(e.target.value)}
                  placeholder="Stockholm"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <div className="text-xs text-muted-foreground">
              {hasUnsavedNarrative ? (
                <span>Ändringar sparas inte automatiskt.</span>
              ) : savedAt ? (
                <span className="inline-flex items-center gap-1 text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Sparat
                </span>
              ) : (
                <span>Alla ändringar är sparade.</span>
              )}
            </div>
            <Button
              onClick={handleSaveNarrative}
              disabled={
                savingNarrative || !hasUnsavedNarrative || lifecycle?.annual_report_locked
              }
            >
              {savingNarrative ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sparar…
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" /> Spara texten
                </>
              )}
            </Button>
          </div>
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Flerårsöversikt</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="py-2">År</th>
                <th className="py-2 text-right">Nettoomsättning</th>
                <th className="py-2 text-right">Resultat efter fin.</th>
                <th className="py-2 text-right">Soliditet</th>
              </tr>
            </thead>
            <tbody>
              {data.forvaltningsberattelse.flerarsoversikt.map((row) => (
                <tr key={row.year} className="border-b border-border last:border-b-0">
                  <td className="py-2">{row.year}</td>
                  <td className="py-2 text-right tabular-nums">
                    {row.data_missing ? 'Saknas' : row.net_revenue.toLocaleString('sv-SE')}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {row.data_missing
                      ? 'Saknas'
                      : row.result_after_financial.toLocaleString('sv-SE')}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {row.data_missing
                      ? 'Saknas'
                      : row.soliditet_pct === null
                        ? '—'
                        : `${row.soliditet_pct.toFixed(1)} %`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card id="annual-report-signatures">
        <CardHeader>
          <CardTitle className="text-base">Underskrifter</CardTitle>
          <p className="text-sm text-muted-foreground">
            Lägg till varje styrelseledamot + VD som ska skriva under. Signera
            digitalt med BankID, eller markera som signerad om underskriften
            gjorts på papper. Observera: digital inlämning till Bolagsverket
            kräver deras egen signeringstjänst — BankID-signeringen här
            dokumenterar styrelsens fastställelse i Nordklart.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {signatures.length === 0 && (
            <p className="text-sm text-muted-foreground italic">
              Inga undertecknare tillagda än.
            </p>
          )}
          {signatures.map((sig) => (
            <div
              key={sig.id}
              className="flex items-center justify-between border-b border-border last:border-b-0 pb-3 last:pb-0"
            >
              <div>
                <p className="text-sm font-medium">{sig.signer_name}</p>
                <p className="text-xs text-muted-foreground">{sig.role}</p>
              </div>
              <div className="flex items-center gap-2">
                {sig.status === 'signed' ? (
                  <Badge variant="success">Signerad</Badge>
                ) : sig.status === 'declined' ? (
                  <Badge variant="destructive">Avböjd</Badge>
                ) : (
                  <>
                    <Badge variant="outline">Väntar på underskrift</Badge>
                    <Button
                      size="sm"
                      onClick={() => setBankIdSignFor(sig)}
                      disabled={lifecycle?.annual_report_locked}
                    >
                      Signera med BankID
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleMarkSigned(sig.id)}
                      disabled={lifecycle?.annual_report_locked}
                    >
                      Markera som signerad
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
          {bankIdSignFor && (
            <ConsentSigningDialog
              open={!!bankIdSignFor}
              onClose={() => setBankIdSignFor(null)}
              consentType="arsredovisning_signature"
              title={`Underskrift av årsredovisning — ${bankIdSignFor.signer_name}`}
              consentText={
                `Jag, ${bankIdSignFor.signer_name} (${bankIdSignFor.role}), intygar att ` +
                `årsredovisningen har upprättats och fastställts, och skriver under den ` +
                `digitalt via BankID i Nordklart.`
              }
              context={{
                kind: 'arsredovisning_signature',
                signature_request_id: bankIdSignFor.id,
                fiscal_period_id: periodId,
              }}
              onSigned={() => {
                setBankIdSignFor(null)
                setSignatures((prev) =>
                  prev.map((s) =>
                    s.id === bankIdSignFor.id
                      ? { ...s, status: 'signed', signed_at: new Date().toISOString() }
                      : s,
                  ),
                )
                toast({ title: 'Underskrift signerad med BankID' })
                void refreshAnnualReportState()
              }}
            />
          )}
          <div className="flex flex-wrap gap-2 items-end pt-2">
            <div className="space-y-1">
              <Label htmlFor="signer-role" className="text-xs">
                Roll
              </Label>
              <select
                id="signer-role"
                className="border border-border rounded-md h-9 text-sm px-2 bg-background"
                value={signerRole}
                onChange={(e) => setSignerRole(e.target.value)}
                disabled={lifecycle?.annual_report_locked}
              >
                <option>Styrelseledamot</option>
                <option>Styrelseordförande</option>
                <option>VD</option>
                <option>Verkställande direktör</option>
              </select>
            </div>
            <div className="space-y-1 flex-1 min-w-[200px]">
              <Label htmlFor="signer-name" className="text-xs">
                Namn
              </Label>
              <Input
                id="signer-name"
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder="t.ex. Anna Andersson"
                className="h-9"
                disabled={lifecycle?.annual_report_locked}
              />
            </div>
            <Button
              onClick={handleAddSigner}
              disabled={!signerName.trim() || lifecycle?.annual_report_locked}
            >
              <Plus className="mr-1 h-4 w-4" /> Lägg till
            </Button>
          </div>
        </CardContent>
      </Card>


      <Card id="annual-report-reclassifications">
        <CardHeader>
          <CardTitle className="text-base">Presentationsomklassificeringar</CardTitle>
          <p className="text-sm text-muted-foreground">
            Flytta ett onormalt debetsaldo på ett skuldkonto till en fordringsrad enbart i
            årsredovisningen. Ingen verifikation skapas och huvudboken ändras inte.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {(lifecycle?.presentation_reclassifications ?? []).map((entry) => (
            <div key={entry.id} className="rounded-md border border-border p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    Konto {entry.account_number}: {entry.amount.toLocaleString('sv-SE')} kr
                  </p>
                  <p className="text-muted-foreground">
                    {entry.source_concept} → {entry.target_presentation}
                  </p>
                  <p className="mt-1">{entry.reason}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={lifecycle?.annual_report_locked || revokingReclassificationId === entry.id}
                  onClick={() => void handleRevokeReclassification(entry.id)}
                >
                  {revokingReclassificationId === entry.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Återkalla
                </Button>
              </div>
            </div>
          ))}
          {(lifecycle?.presentation_reclassifications ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Inga aktiva presentationsomklassificeringar.</p>
          ) : null}
          <fieldset disabled={lifecycle?.annual_report_locked} className="grid grid-cols-1 gap-3 rounded-md border border-border p-4 disabled:opacity-70 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="reclass-account">Konto</Label>
              <Input
                id="reclass-account"
                inputMode="numeric"
                maxLength={4}
                value={reclassAccount}
                onChange={(event) => setReclassAccount(event.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="2893"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reclass-amount">Belopp</Label>
              <Input
                id="reclass-amount"
                inputMode="decimal"
                value={reclassAmount}
                onChange={(event) => setReclassAmount(event.target.value)}
                placeholder="1250,00"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reclass-target">Presentera som</Label>
              <select
                id="reclass-target"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={reclassTargetConcept}
                onChange={(event) => {
                  const concept = event.target.value
                  setReclassTargetConcept(concept)
                  setReclassTargetLabel(
                    concept === 'Kundfordringar'
                      ? 'Kundfordringar'
                      : concept === 'AndraLangfristigaFordringar'
                        ? 'Andra långfristiga fordringar'
                        : 'Övriga kortfristiga fordringar',
                  )
                }}
              >
                <option value="OvrigaFordringarKortfristiga">Övriga kortfristiga fordringar</option>
                <option value="Kundfordringar">Kundfordringar</option>
                <option value="AndraLangfristigaFordringar">Andra långfristiga fordringar</option>
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="reclass-reason">Motivering</Label>
              <Textarea
                id="reclass-reason"
                value={reclassReason}
                onChange={(event) => setReclassReason(event.target.value)}
                rows={2}
                placeholder="Förklara varför saldot ska presenteras som en fordran."
              />
            </div>
            <div className="sm:col-span-2">
              <Button
                type="button"
                onClick={() => void handleCreateReclassification()}
                disabled={savingReclassification}
              >
                {savingReclassification ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Spara presentationsomklassificering
              </Button>
            </div>
          </fieldset>
        </CardContent>
      </Card>

      <Card id="controlled-reopen">
        <CardHeader>
          <CardTitle className="text-base">Återöppna räkenskapsår för rättelse</CardTitle>
          <p className="text-sm text-muted-foreground">
            Använd endast detta när bokföringen måste rättas. Dokumenttexter, jämförelsetal och
            undertecknare kan ändras utan att huvudboken öppnas.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="reopen-reason">Orsak</Label>
              <Textarea
                id="reopen-reason"
                value={reopenReason}
                onChange={(event) => setReopenReason(event.target.value)}
                rows={3}
                placeholder="Beskriv varför den låsta huvudboken måste rättas."
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="reopen-changes">Poster som ska ändras</Label>
              <Textarea
                id="reopen-changes"
                value={reopenChanges}
                onChange={(event) => setReopenChanges(event.target.value)}
                rows={3}
                placeholder="En ändring per rad, exempelvis: Rätta skatt på årets resultat."
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reopen-approver">Godkännare</Label>
              <Input
                id="reopen-approver"
                value={reopenApprover}
                onChange={(event) => setReopenApprover(event.target.value)}
                placeholder="Namn på behörig godkännare"
              />
            </div>
            <div className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={annualReportAlreadyFiled}
                  onChange={(event) => setAnnualReportAlreadyFiled(event.target.checked)}
                />
                Årsredovisningen är redan inlämnad
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={taxReturnAlreadyFiled}
                  onChange={(event) => setTaxReturnAlreadyFiled(event.target.checked)}
                />
                Deklarationen är redan inlämnad
              </label>
            </div>
          </div>
          <Button onClick={handleRequestReopen} disabled={submittingReopen} variant="destructive">
            {submittingReopen && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Skapa återöppningsbegäran
          </Button>

          {reopenRequests.length > 0 && (
            <div className="space-y-2 border-t border-border pt-4">
              <p className="font-medium">Tidigare begäranden</p>
              {reopenRequests.map((request) => (
                <div key={request.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">{request.reason}</p>
                      <p className="text-xs text-muted-foreground">
                        Godkännare: {request.designated_approver_name} · {request.status}
                      </p>
                    </div>
                    {request.status === 'requested' && (
                      <Button
                        size="sm"
                        onClick={() => void handleApproveReopen(request.id)}
                        disabled={approvingReopenId === request.id}
                      >
                        {approvingReopenId === request.id && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Godkänn och återöppna
                      </Button>
                    )}
                  </div>
                  {request.error_message && (
                    <p className="mt-2 text-destructive">{request.error_message}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ladda ner & lämna in</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            Utkast kan alltid granskas. En slutversion skapas först när huvudboken är
            stängd och samtliga dokument-, underskrifts-, jämförelse- och iXBRL-kontroller
            är godkända.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" asChild>
              <Link href={pdfUrl} target="_blank" rel="noopener noreferrer">
                <FileDown className="mr-2 h-4 w-4" /> Ladda ner PDF-utkast
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link
                href={`/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/ixbrl${companySuffix}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <FileDown className="mr-2 h-4 w-4" /> Ladda ner iXBRL-utkast
              </Link>
            </Button>
            {lifecycle?.annual_report_locked ? (
              <Button onClick={handleCreateNewVersion} disabled={creatingVersion}>
                {creatingVersion ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Skapa ny version
              </Button>
            ) : (
              <Button
                onClick={handleFinalize}
                disabled={
                  finalizing ||
                  hasUnsavedNarrative ||
                  (lifecycle?.preflight.blocking_issue_count ?? 1) > 0
                }
              >
                {finalizing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <LockKeyhole className="mr-2 h-4 w-4" />
                )}
                Färdigställ årsredovisning
              </Button>
            )}
            {lifecycle?.final_pdf_url && (
              <Button asChild>
                <Link
                  href={`${lifecycle.final_pdf_url}${companyId ? `&company_id=${encodeURIComponent(companyId)}` : ''}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <FileDown className="mr-2 h-4 w-4" /> Ladda ner slutlig PDF
                </Link>
              </Button>
            )}
            {lifecycle?.final_ixbrl_url && (
              <Button variant="outline" asChild>
                <Link
                  href={`${lifecycle.final_ixbrl_url}${companyId ? `&company_id=${encodeURIComponent(companyId)}` : ''}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <FileDown className="mr-2 h-4 w-4" /> Ladda ner slutlig iXBRL
                </Link>
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link
                href="https://www.bolagsverket.se/foretag/aktiebolag/arsredovisning/lamna-in-arsredovisning"
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="mr-2 h-4 w-4" /> Bolagsverket Mina Sidor
              </Link>
            </Button>
          </div>
          {data.warnings.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-warning-foreground space-y-1">
              <p className="font-medium">Innan inlämning till Bolagsverket:</p>
              <ul className="list-disc pl-5 space-y-1">
                {data.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {lifecycle && (
            <div className="rounded-md border border-border p-3 text-xs space-y-2">
              <div className="flex items-center justify-between gap-2">
                <strong>Preflight: {lifecycle.preflight.preflight_status === 'passed' ? 'godkänd' : 'blockerad'}</strong>
                <Badge variant={lifecycle.preflight.blocking_issue_count === 0 ? 'success' : 'destructive'}>
                  {lifecycle.preflight.blocking_issue_count} blockerare
                </Badge>
              </div>
              {lifecycle.preflight.issues.map((issue) => (
                <div key={issue.code} className="rounded border border-border p-2">
                  <p className="font-medium">{issue.message}</p>
                  <p className="text-muted-foreground mt-1">
                    {issue.scope === 'ledger'
                      ? 'Påverkar huvudboken.'
                      : 'Dokumentuppgift — kan rättas utan att huvudboken öppnas.'}
                  </p>
                  {issue.actions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {issue.actions.map((action) => (
                        <Button
                          key={action.id}
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => focusIssueAction(action.id, issue.requires_reopen)}
                        >
                          {action.label}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
