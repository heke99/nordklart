'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { BankIdAuth } from '@/components/auth/BankIdAuth'
import type { BankIdResult } from '@/components/auth/BankIdAuth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type Props = {
  /** Where to continue after linking: resume the signup draft, or return to a company wizard. */
  next: 'signup' | 'companies_new' | 'onboarding'
}

export function OnboardingBankIdStep({ next }: Props) {
  const t = useTranslations('onboarding_bankid')
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)
  const [isContinuing, setIsContinuing] = useState(false)
  const [attempt, setAttempt] = useState(0)

  async function handleComplete(result: BankIdResult) {
    if (result.error) {
      setMessage(result.error === 'already_linked' ? t('already_linked') : t('link_failed'))
      setAttempt((n) => n + 1)
      return
    }

    setMessage(t('linked'))
    if (next !== 'signup') {
      router.replace(next === 'companies_new' ? '/companies/new' : '/onboarding?add=company')
      return
    }

    setIsContinuing(true)
    try {
      const response = await fetch('/api/auth/signup-draft/retry', { method: 'POST' })
      const body = await response.json().catch(() => ({})) as { onboardingPath?: string; error?: string }
      if ((response.ok || response.status === 202) && body.onboardingPath) {
        router.replace(body.onboardingPath)
        router.refresh()
        return
      }
      setMessage(body.error || t('link_failed'))
    } finally {
      setIsContinuing(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4">
        {isContinuing ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('continuing')}
          </p>
        ) : (
          <BankIdAuth key={attempt} mode="link" onComplete={handleComplete} />
        )}
        {message ? <p className="text-center text-sm text-muted-foreground" role="status">{message}</p> : null}
        <p className="text-center text-xs text-muted-foreground">{t('manual_review_note')}</p>
      </CardContent>
    </Card>
  )
}
