'use client'

import { Suspense, useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Mail, ArrowLeft, KeyRound, ExternalLink } from 'lucide-react'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { isBankIdEnabled } from '@/lib/auth/bankid'
import { BankIdAuth } from '@/components/auth/BankIdAuth'
import { getBranding } from '@/lib/branding/service'
import { detectWebmailHint } from '@/lib/auth/webmail-search'
import { AuthLegalFooter } from '@/components/auth/AuthLegalFooter'
import { isRecoverableSignupProvisioningStatus } from '@/lib/signup/provisioning-status'
import { safeReturnTo } from '@/lib/auth/safe-return-to'
import { clearRecaptIdentity } from '@/lib/recapt'
import type { BankIdResult } from '@/components/auth/BankIdAuth'

const branding = getBranding()

// Wrapping in Suspense is required because useSearchParams() forces
// dynamic rendering in Next.js 16; static prerender bails out otherwise.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageContent />
    </Suspense>
  )
}

function LoginPageContent() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isEmailSent, setIsEmailSent] = useState(false)
  const [showResetPassword, setShowResetPassword] = useState(false)
  const [resetCooldownUntil, setResetCooldownUntil] = useState<number | null>(null)
  const [resetCooldownRemaining, setResetCooldownRemaining] = useState(0)
  const [bankIdNoAccount, setBankIdNoAccount] = useState<{ givenName?: string; surname?: string } | null>(null)
  const [existingSessionEmail, setExistingSessionEmail] = useState<string | null>(null)
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false)
  const { toast } = useToast()
  const searchParams = useSearchParams()
  const legacyCallbackError = searchParams.get('error')
  const callbackError = searchParams.get('auth_error')
    ?? (legacyCallbackError === 'auth_error' ? 'password_reset_failed' : null)
  const [supabase] = useState(() => createClient())
  const requestedNext = safeReturnTo(searchParams.get('next'), '/app')
  const bankIdEnabled = isBankIdEnabled()
  const tAuth = useTranslations('auth')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  const isSignupConfirmationError = callbackError === 'signup_confirmation_failed'
  const isPasswordResetError = callbackError === 'password_reset_failed'
  const isInviteError = callbackError === 'invite_failed'
  const isMagicLinkError = callbackError === 'magic_link_failed'
  const isEmailChangeError = callbackError === 'email_change_failed'

  useEffect(() => {
    let active = true
    supabase.auth.getUser().then(({ data }) => {
      if (active) setExistingSessionEmail(data.user?.email ?? null)
    })
    return () => {
      active = false
    }
  }, [supabase])

  const navigateAfterAuth = (path: string) => {
    // Authentication changes cookies. A hard navigation prevents the App
    // Router from reusing an anonymous or previously authenticated RSC tree.
    window.location.assign(path)
  }

  const handleSwitchAccount = async () => {
    setIsSwitchingAccount(true)
    clearRecaptIdentity()
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      window.location.replace('/login?account_switched=1')
    }
  }

  // Reset cooldown timer
  useEffect(() => {
    if (!resetCooldownUntil) return
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((resetCooldownUntil - Date.now()) / 1000))
      setResetCooldownRemaining(remaining)
      if (remaining <= 0) setResetCooldownUntil(null)
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [resetCooldownUntil])

  const [bankIdUnavailable, setBankIdUnavailable] = useState(false)

  const handleBankIdComplete = async (result: BankIdResult) => {
    if (result.error === 'no_account') {
      setBankIdNoAccount({ givenName: result.givenName, surname: result.surname })
      return
    }

    if (result.error === 'service_unavailable') {
      setBankIdUnavailable(true)
      return
    }

    if (result.error) {
      toast({
        title: tAuth('login_failed_title'),
        description: tAuth('login_failed_bankid'),
        variant: 'destructive',
      })
      return
    }

    if (result.tokenHash && result.type) {
      try {
        const { error } = await supabase.auth.verifyOtp({
          token_hash: result.tokenHash,
          type: result.type as 'magiclink',
        })

        if (error) {
          console.error('[login] BankID verifyOtp failed', error)
          toast({
            title: tAuth('login_failed_title'),
            description: tAuth('login_failed_bankid'),
            variant: 'destructive',
          })
          return
        }

        // Check for pending invite token
        const bankIdCookieMatch = document.cookie.match(/nordklart-invite-token=([^;]+)/)
        const bankIdInviteToken = bankIdCookieMatch?.[1]

        if (bankIdInviteToken) {
          try {
            const res = await fetch('/api/team/accept', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: bankIdInviteToken }),
            })

            if (res.ok) {
              document.cookie = 'nordklart-invite-token=; path=/; max-age=0'
              window.location.href = '/app'
              return
            }
          } catch (err) {
            console.error('[login] invite acceptance failed:', err)
          }
          document.cookie = 'nordklart-invite-token=; path=/; max-age=0'
        }

        // Always land on the picker after BankID login so the user sees
        // fresh CompanyRoles fetched during this session's enrichment.
        navigateAfterAuth('/select-company')
      } catch (error) {
        console.error('[login] BankID complete error', error)
        toast({
          title: tAuth('login_failed_title'),
          description: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
          variant: 'destructive',
        })
      }
    }
  }

  const handlePasswordLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)

    const formData = new FormData(e.currentTarget)
    const emailValue = (formData.get('email') as string) || email
    const passwordValue = (formData.get('password') as string) || password

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: emailValue,
        password: passwordValue,
      })

      if (error) {
        toast({
          title: tAuth('login_failed_title'),
          description: error.message === 'Invalid login credentials'
            ? tAuth('login_invalid_credentials')
            : getErrorMessage(error, { context: 'auth', locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }

      // Check MFA status
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()

      if (aal?.nextLevel === 'aal2' && aal?.currentLevel === 'aal1') {
        navigateAfterAuth('/mfa/verify')
        return
      }

      // Check for pending invite token
      const cookieMatch = document.cookie.match(/nordklart-invite-token=([^;]+)/)
      const inviteToken = cookieMatch?.[1]

      if (inviteToken) {
        try {
          const res = await fetch('/api/team/accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: inviteToken }),
          })

          if (res.ok) {
            document.cookie = 'nordklart-invite-token=; path=/; max-age=0'
            window.location.href = '/app'
            return
          }
        } catch (err) {
          console.error('[login] invite acceptance failed:', err)
        }
        // Clear cookie even on failure to avoid retrying stale tokens
        document.cookie = 'nordklart-invite-token=; path=/; max-age=0'
      }

      const activation = await fetch('/api/auth/signup-draft/claim', { method: 'POST' })
      if (activation.status === 200 || activation.status === 202) {
        const workspace = await activation.json().catch(() => null) as { onboardingPath?: string; state?: string } | null
        if (activation.status === 202 || workspace?.state === 'access_request_pending') {
          navigateAfterAuth('/access-pending')
          return
        }
        if (workspace?.onboardingPath) {
          navigateAfterAuth(workspace.onboardingPath)
          return
        }
      }
      if (isRecoverableSignupProvisioningStatus(activation.status)) {
        // The account is valid. Keep the session so setup can be retried
        // idempotently from the recovery screen instead of forcing another login.
        navigateAfterAuth('/onboarding/problem')
        return
      }
      if (activation.status !== 204) {
        const body = await activation.json().catch(() => ({})) as { error?: string }
        toast({
          title: 'Kunde inte starta installationen',
          description: body.error || 'Försök igen om en stund.',
          variant: 'destructive',
        })
        navigateAfterAuth('/onboarding/problem')
        return
      }

      navigateAfterAuth(requestedNext)
    } catch (error) {
      toast({
        title: tAuth('login_failed_title'),
        description: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleResetPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)

    const formData = new FormData(e.currentTarget)
    const emailValue = (formData.get('email') as string) || email

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(emailValue, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      })

      if (error) {
        toast({
          title: tAuth('reset_failed_title'),
          description: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }

      setEmail(emailValue)
      setResetCooldownUntil(Date.now() + 60_000)
      setIsEmailSent(true)
      toast({
        title: tAuth('reset_sent_title'),
        description: tAuth('reset_sent_body'),
      })
    } catch (error) {
      toast({
        title: tAuth('reset_failed_title'),
        description: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  // Email sent confirmation screen
  if (isEmailSent) {
    const webmailHint = detectWebmailHint(email, branding.authEmailFrom)

    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
        <div className="w-full max-w-sm animate-slide-up space-y-8">
          <div className="flex justify-center">
            <div className="h-14 w-14 rounded-2xl bg-primary/8 flex items-center justify-center">
              <Mail className="h-7 w-7 text-primary" />
            </div>
          </div>

          <div className="text-center space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">{tAuth('email_sent_title')}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {showResetPassword
                ? tAuth.rich('email_sent_body_reset', {
                    email,
                    strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
                  })
                : tAuth.rich('email_sent_body_login', {
                    email,
                    strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
                  })}
            </p>
          </div>

          <div className="rounded-xl border bg-card p-4">
            <p className="text-sm text-muted-foreground text-center leading-relaxed">
              {showResetPassword ? tAuth('email_sent_hint_reset') : tAuth('email_sent_hint_login')}
            </p>
          </div>

          <div className="space-y-2">
            {webmailHint && (
              <Button className="w-full" asChild>
                <a href={webmailHint.url} target="_blank" rel="noopener noreferrer">
                  {tAuth(webmailHint.hasSearch ? 'open_webmail_search' : 'open_webmail_inbox', {
                    provider: webmailHint.name,
                  })}
                  <ExternalLink className="ml-2 h-4 w-4" />
                </a>
              </Button>
            )}
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={() => {
                setIsEmailSent(false)
                setShowResetPassword(false)
              }}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {tCommon('back')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Reset password form
  if (showResetPassword) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
        <div className="w-full max-w-sm animate-slide-up">
          <div className="text-center mb-10">
            <div className="flex justify-center mb-4">
              <div className="h-14 w-14 rounded-2xl bg-primary/8 flex items-center justify-center">
                <KeyRound className="h-7 w-7 text-primary" />
              </div>
            </div>
            <h1 className="text-2xl font-medium tracking-tight">{tAuth('reset_title')}</h1>
            <p className="text-muted-foreground text-sm mt-2">
              {tAuth('reset_subtitle')}
            </p>
          </div>

          <div className="rounded-xl border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
            <form onSubmit={handleResetPassword} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email">{tAuth('email_label')}</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder={tAuth('email_placeholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isLoading}
                  className="h-11"
                />
              </div>
              <Button type="submit" className="w-full h-11" disabled={isLoading || !!resetCooldownUntil}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {tAuth('reset_sending')}
                  </>
                ) : resetCooldownUntil ? (
                  tAuth('reset_cooldown', { seconds: resetCooldownRemaining })
                ) : (
                  tAuth('reset_button')
                )}
              </Button>
            </form>
          </div>

          <Button
            variant="ghost"
            className="w-full mt-4 text-muted-foreground"
            onClick={() => setShowResetPassword(false)}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {tAuth('back_to_login')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-10">
          <BrandWordmark size="hero" className="mb-2" />
          <p className="text-muted-foreground text-sm mt-3">
            {tAuth('login_subtitle')}
          </p>
        </div>

        <div className="rounded-xl border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
          {existingSessionEmail && (
            <div className="mb-5 rounded-lg border border-primary/25 bg-primary/5 p-4" role="status">
              <p className="text-sm font-medium text-foreground">Du är redan inloggad</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Sessionen tillhör <strong className="text-foreground">{existingSessionEmail}</strong>.
                Fortsätt till appen eller logga ut för att använda ett annat konto.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Button type="button" onClick={() => navigateAfterAuth('/app')}>
                  Fortsätt till appen
                </Button>
                <Button type="button" variant="outline" onClick={handleSwitchAccount} disabled={isSwitchingAccount}>
                  {isSwitchingAccount ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Byt konto
                </Button>
              </div>
            </div>
          )}
          {callbackError && (
            <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 p-4" role="alert">
              <p className="text-sm font-medium text-destructive">
                {isSignupConfirmationError
                  ? tAuth('signup_confirmation_error_title')
                  : isPasswordResetError
                    ? tAuth('password_reset_error_title')
                    : isInviteError
                      ? tAuth('invite_error_title')
                      : isMagicLinkError
                        ? tAuth('magic_link_error_title')
                        : isEmailChangeError
                          ? tAuth('email_change_error_title')
                          : tAuth('auth_link_error_title')}
              </p>
              <p className="mt-1 text-sm text-destructive/90">
                {isSignupConfirmationError
                  ? tAuth('signup_confirmation_error_body')
                  : isPasswordResetError
                    ? tAuth('password_reset_error_body')
                    : isInviteError
                      ? tAuth('invite_error_body')
                      : isMagicLinkError
                        ? tAuth('magic_link_error_body')
                        : isEmailChangeError
                          ? tAuth('email_change_error_body')
                          : tAuth('auth_link_error_body')}{' '}
                <Link
                  href={isSignupConfirmationError ? '/confirm-email' : isPasswordResetError ? '/forgot-password' : '/login'}
                  className="font-medium underline underline-offset-2"
                >
                  {isSignupConfirmationError
                    ? tAuth('request_new_confirmation_link')
                    : isPasswordResetError
                      ? tAuth('request_new_reset_link')
                      : tAuth('return_to_login')}
                </Link>
                .
              </p>
            </div>
          )}
          {bankIdEnabled && (
            <>
              {bankIdNoAccount ? (
                <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    {tAuth('bankid_no_account_greeting', { name: bankIdNoAccount.givenName ?? '' })}
                  </p>
                  <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                    {tAuth('bankid_no_account_body')}
                  </p>
                  <p className="mt-2">
                    <button
                      type="button"
                      onClick={() => setBankIdNoAccount(null)}
                      className="text-xs text-amber-600 underline underline-offset-2 hover:text-amber-800 dark:text-amber-400"
                    >
                      {tAuth('bankid_no_account_create')}
                    </button>
                  </p>
                </div>
              ) : (
                <div className="mb-5">
                  <BankIdAuth mode="login" onComplete={handleBankIdComplete} />
                </div>
              )}
              <div className="relative mb-5">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">{tAuth('or_email_divider')}</span>
                </div>
              </div>
            </>
          )}
          {bankIdUnavailable && (
            <div className="mb-5 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/30">
              <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                {tAuth('bankid_unavailable_title')}
              </p>
              <p className="mt-1 text-sm text-blue-700 dark:text-blue-300">
                {tAuth('bankid_unavailable_body')}
              </p>
            </div>
          )}
          <form onSubmit={handlePasswordLogin} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">{tAuth('email_label')}</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder={tAuth('email_placeholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">{tAuth('password_label')}</Label>
                <Link
                  href="/forgot-password"
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                >
                  {tAuth('forgot_password')}
                </Link>
              </div>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder={tAuth('password_placeholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
                className="h-11"
              />
            </div>
            <Button type="submit" className="w-full h-11" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {tAuth('logging_in')}
                </>
              ) : (
                tAuth('login_button')
              )}
            </Button>
          </form>

          <div className="relative my-5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">{tAuth('or_divider')}</span>
            </div>
          </div>

          <Button
            variant="outline"
            className="w-full"
            asChild
          >
            <Link href="/register">
              {tAuth('no_account')}
            </Link>
          </Button>
        </div>

        <AuthLegalFooter className="mt-6" />
      </div>
    </div>
  )
}
