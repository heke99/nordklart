'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, Mail } from 'lucide-react'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { AuthLegalFooter } from '@/components/auth/AuthLegalFooter'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSent, setIsSent] = useState(false)
  const { toast } = useToast()

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setIsLoading(true)

    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })

      setIsSent(true)
      toast({
        title: 'Kontrollera din inkorg',
        description: 'Om kontot finns skickar vi en återställningslänk till e-postadressen.',
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="mb-10 text-center">
          <BrandWordmark size="hero" className="mb-2" />
          <p className="mt-3 text-sm text-muted-foreground">Återställ lösenordet till ditt Nordklart-konto.</p>
        </div>

        <div className="rounded-xl border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
          {isSent ? (
            <div className="space-y-5 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/8">
                <Mail className="h-7 w-7 text-primary" />
              </div>
              <div className="space-y-2">
                <h1 className="text-2xl font-medium tracking-tight">Länk skickad</h1>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Om <span className="font-medium text-foreground">{email}</span> finns hos Nordklart får du en återställningslänk inom kort.
                </p>
              </div>
              <Button asChild className="w-full">
                <Link href="/login">Tillbaka till login</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email">E-post</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="namn@bolag.se"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isLoading}
                  className="h-11"
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Av säkerhetsskäl visar vi samma svar oavsett om e-postadressen finns eller inte.
                </p>
              </div>
              <Button type="submit" className="h-11 w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Skickar...
                  </>
                ) : (
                  'Skicka återställningslänk'
                )}
              </Button>
            </form>
          )}
        </div>

        <Button variant="ghost" className="mt-4 w-full text-muted-foreground" asChild>
          <Link href="/login">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Tillbaka till login
          </Link>
        </Button>

        <AuthLegalFooter className="mt-6" />
      </div>
    </div>
  )
}
