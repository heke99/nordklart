'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { clearRecaptIdentity } from '@/lib/recapt'

/**
 * Loads the Recapt SDK (session replay and feedback) only after the visitor
 * has opted in, and never on authentication pages.
 *
 * Replay reads and stores what happens in the browser, so under LEK 9 kap.
 * 28 § / ePrivacy art. 5(3) it needs prior consent; it is not a strictly
 * necessary cookie. The choice is kept for a year in the `nordklart-consent`
 * cookie ('analytics' or 'necessary'). Without a public key nothing renders.
 */
export const CONSENT_COOKIE = 'nordklart-consent'
const CONSENT_MAX_AGE = 60 * 60 * 24 * 365

// Pages where personal data is typed (credentials, personnummer, TOTP codes)
// are never recorded, whatever the consent.
const NO_REPLAY_PREFIXES = [
  '/login', '/register', '/forgot-password', '/reset-password', '/confirm-email',
  '/mfa', '/auth', '/account/set-password', '/invite', '/onboarding/bankid', '/bankid',
]

type Consent = 'analytics' | 'necessary' | null

function readConsent(): Consent {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${CONSENT_COOKIE}=([^;]+)`))
  const value = match?.[1]
  return value === 'analytics' || value === 'necessary' ? value : null
}

function writeConsent(value: Exclude<Consent, null>) {
  const secure = window.location.protocol === 'https:' ? '; secure' : ''
  document.cookie = `${CONSENT_COOKIE}=${value}; path=/; max-age=${CONSENT_MAX_AGE}; samesite=lax${secure}`
}

function loadRecapt(publicKey: string) {
  if (document.querySelector('script[data-recapt-loader]')) return
  const script = document.createElement('script')
  script.src = 'https://cdn.recapt.app/browser/glimt.js'
  script.async = true
  script.dataset.publicKey = publicKey
  script.dataset.persist = ''
  script.dataset.enableUserComments = ''
  script.dataset.recaptLoader = ''
  document.head.appendChild(script)
}

export function RecaptLoader() {
  const publicKey = process.env.NEXT_PUBLIC_RECAPT_PUBLIC_KEY
  const pathname = usePathname() ?? ''
  const [consent, setConsent] = useState<Consent>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // Cookie is only readable in the browser; decided after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConsent(readConsent())
    setReady(true)
  }, [])

  const replayAllowed = !NO_REPLAY_PREFIXES.some((prefix) => pathname.startsWith(prefix))

  useEffect(() => {
    if (!publicKey || consent !== 'analytics' || !replayAllowed) return
    loadRecapt(publicKey)
  }, [publicKey, consent, replayAllowed])

  if (!publicKey || !ready || consent !== null) return null

  const choose = (value: Exclude<Consent, null>) => {
    writeConsent(value)
    if (value === 'necessary') clearRecaptIdentity()
    setConsent(value)
  }

  return (
    <div
      role="dialog"
      aria-label="Cookies"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-xl rounded-lg border border-border bg-background p-4 shadow-lg md:p-6"
    >
      <p className="text-sm">
        Vi använder nödvändiga cookies för inloggning och säkerhet. Med ditt samtycke använder vi
        även analys och sessionsinspelning (Recapt) för att förbättra tjänsten. Inloggnings- och
        BankID-sidor spelas aldrig in.{' '}
        <a href="/cookies" className="underline underline-offset-2">Läs mer</a>
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => choose('analytics')}>Tillåt analys</Button>
        <Button size="sm" variant="secondary" onClick={() => choose('necessary')}>Endast nödvändiga</Button>
      </div>
    </div>
  )
}
