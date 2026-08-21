'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { BankIdQrCode } from '@/components/auth/BankIdQrCode'
import { useToast } from '@/components/ui/use-toast'

/**
 * Reusable BankID consent-signing dialog.
 *
 * Drives the full flow against /api/bankid/consents:
 *   start → poll (2s) → QR (other device) / autostart link (same device)
 *   → complete/failed/cancelled.
 *
 * Consumers (agency sharing, invoice financing, Bankgiro application,
 * årsredovisning signing) pass the consent type + text and get the created
 * consent id back via onSigned.
 */

export interface ConsentSigningDialogProps {
  open: boolean
  onClose: () => void
  consentType:
    | 'agency_data_sharing'
    | 'bank_connection'
    | 'skatteverket'
    | 'invoice_financing'
    | 'api_integration'
    | 'bankgiro_autogiro'
    | 'arsredovisning_signature'
    | 'other'
  title: string
  consentText: string
  context?: Record<string, unknown>
  onSigned: (consentId: string) => void
}

type Phase = 'idle' | 'starting' | 'pending' | 'complete' | 'failed' | 'cancelled'

export function ConsentSigningDialog({
  open,
  onClose,
  consentType,
  title,
  consentText,
  context,
  onSigned,
}: ConsentSigningDialogProps) {
  const { toast } = useToast()
  const [phase, setPhase] = useState<Phase>('idle')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [autoStartToken, setAutoStartToken] = useState<string | null>(null)
  const [qrStartToken, setQrStartToken] = useState<string | null>(null)
  const [qrStartSecret, setQrStartSecret] = useState<string | null>(null)
  // See BankIdQrCode: the QR time field counts from the order's creation on the
  // server, so the server tells us how old the order already was.
  const [qrOrderAgeMs, setQrOrderAgeMs] = useState(0)
  const [hint, setHint] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  const reset = useCallback(() => {
    stopPolling()
    setPhase('idle')
    setSessionId(null)
    setAutoStartToken(null)
    setQrStartToken(null)
    setQrStartSecret(null)
    setQrOrderAgeMs(0)
    setHint(null)
  }, [stopPolling])

  const startSigning = useCallback(async () => {
    setPhase('starting')
    try {
      const res = await fetch('/api/bankid/consents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          consent_type: consentType,
          title,
          consent_text: consentText,
          context,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte starta godkännandet',
          description: json?.error?.message || json?.error || '',
          variant: 'destructive',
        })
        setPhase('failed')
        return
      }
      setSessionId(json.data.sessionId)
      setAutoStartToken(json.data.autoStartToken)
      setQrStartToken(json.data.qrStartToken)
      setQrStartSecret(json.data.qrStartSecret)
      setQrOrderAgeMs(json.data.qrOrderAgeMs ?? 0)
      setPhase('pending')
    } catch {
      toast({ title: 'Kunde inte starta godkännandet', variant: 'destructive' })
      setPhase('failed')
    }
  }, [consentType, title, consentText, context, toast])

  // Poll while pending.
  useEffect(() => {
    if (phase !== 'pending' || !sessionId) return
    let cancelled = false
    pollTimer.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/bankid/consents/${sessionId}/poll`, { method: 'POST' })
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) return
        const data = json.data as {
          status: Phase
          hintCode: string | null
          consentId: string | null
          qrStartToken?: string | null
          qrStartSecret?: string | null
          qrOrderAgeMs?: number
        }
        setHint(data.hintCode)
        if (data.qrStartToken) setQrStartToken(data.qrStartToken)
        if (data.qrStartSecret) setQrStartSecret(data.qrStartSecret)
        if (data.qrStartToken) setQrOrderAgeMs(data.qrOrderAgeMs ?? 0)
        if (data.status === 'complete' && data.consentId) {
          stopPolling()
          setPhase('complete')
          onSigned(data.consentId)
        } else if (data.status === 'failed' || data.status === 'cancelled') {
          stopPolling()
          setPhase(data.status)
        }
      } catch {
        // transient poll failure — keep polling
      }
    }, 2000)
    return () => {
      cancelled = true
      stopPolling()
    }
  }, [phase, sessionId, onSigned, stopPolling])

  useEffect(() => {
    if (open) return
    // Deferred so the effect body never sets state synchronously
    // (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => reset(), 0)
    return () => clearTimeout(timer)
  }, [open, reset])

  // Closing the dialog while a session is pending must cancel the session
  // server-side too — otherwise the provider order dangles and the session
  // stays "pending" forever in the database.
  const handleClose = useCallback(() => {
    if (phase === 'pending' && sessionId) {
      void fetch(`/api/bankid/consents/${sessionId}/cancel`, { method: 'POST' }).catch(() => {})
    }
    onClose()
  }, [phase, sessionId, onClose])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {/*
            * Deliberately "godkänn", not "signera". The provider behind this
            * dialog (TIC Identity) exposes BankID *authentication*: it proves
            * who approved the text below and when, and Nordklart stores that
            * text verbatim as consent evidence. That is not a qualified
            * electronic signature, and calling it one in the UI would tell the
            * user their approval carries a legal weight it does not have.
            */}
          <DialogDescription>
            Godkänn med BankID. Din identitet verifieras och texten nedan sparas som bevis.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-sm">
          {consentText}
        </div>

        {phase === 'idle' && (
          <Button onClick={startSigning}>Godkänn med BankID</Button>
        )}
        {phase === 'starting' && (
          <p className="text-sm text-muted-foreground">Startar BankID-session…</p>
        )}
        {phase === 'pending' && (
          <div className="flex flex-col items-center gap-3">
            {qrStartToken && qrStartSecret && (
              <BankIdQrCode
                qrStartToken={qrStartToken}
                qrStartSecret={qrStartSecret}
                orderAgeMs={qrOrderAgeMs}
              />
            )}
            {autoStartToken && (
              <a
                className="text-sm text-primary underline"
                href={`bankid:///?autostarttoken=${autoStartToken}&redirect=null`}
              >
                Öppna BankID på den här enheten
              </a>
            )}
            <p className="text-xs text-muted-foreground">
              {hint === 'userSign'
                ? 'Skriv in din säkerhetskod i BankID-appen.'
                : 'Skanna QR-koden med BankID-appen eller öppna appen på den här enheten.'}
            </p>
          </div>
        )}
        {phase === 'complete' && (
          <p className="text-sm text-success">Samtycket är godkänt och BankID-verifierat.</p>
        )}
        {phase === 'failed' && (
          <p className="text-sm text-destructive">
            Godkännandet misslyckades. Stäng dialogen och försök igen.
          </p>
        )}
        {phase === 'cancelled' && (
          <p className="text-sm text-muted-foreground">Godkännandet avbröts.</p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose}>
            {phase === 'complete' ? 'Stäng' : 'Avbryt'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
