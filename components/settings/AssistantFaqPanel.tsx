'use client'

import { useCallback, useEffect, useState } from 'react'
import { BookOpenCheck, Loader2, Search, TriangleAlert } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { formatDate } from '@/lib/utils'

// "FAQ" tab on /settings/assistant — transparency surface for the assistant's
// seeded Swedish knowledge base (Batch 10):
//   - status card: enabled, indexed entries, last seed date
//   - test box: run a question through the exact retrieval the assistant
//     uses and show matched entries, confidence and the low-confidence
//     fallback so the behavior is inspectable, not magic.

interface FaqStatus {
  enabled: boolean
  expected_entries: number
  indexed_entries: number
  db_seeded: boolean
  last_seeded_at: string | null
  last_updated_at: string | null
}

interface FaqTestMatch {
  id: string
  category: string
  intent: string
  confidence: number
  high_confidence: boolean
  short_answer_sv: string
  answer_sv: string
  sources: string[]
  related_routes: string[]
  risk_level: 'low' | 'medium' | 'high'
  escalation: string | null
  matched_on: string[]
}

interface FaqTestResult {
  query: string
  low_confidence: boolean
  source: 'local' | 'hybrid'
  matches: FaqTestMatch[]
}

const RISK_LABEL: Record<FaqTestMatch['risk_level'], string> = {
  low: 'Låg risk',
  medium: 'Medelrisk',
  high: 'Hög risk',
}

export function AssistantFaqPanel() {
  const { toast } = useToast()

  const [status, setStatus] = useState<FaqStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [question, setQuestion] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<FaqTestResult | null>(null)

  // statusLoading starts true — the effect only clears it once the fetch
  // settles, so no synchronous setState inside the effect body.
  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/faq')
      const json = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte hämta FAQ-status',
          description: json.error,
          variant: 'destructive',
        })
        return
      }
      setStatus(json.data as FaqStatus)
    } finally {
      setStatusLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  async function runTest() {
    const q = question.trim()
    if (q.length < 2) return
    setTesting(true)
    setResult(null)
    try {
      const res = await fetch('/api/agent/faq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, limit: 3 }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Testet misslyckades', description: json.error, variant: 'destructive' })
        return
      }
      setResult(json.data as FaqTestResult)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpenCheck className="h-4 w-4 text-muted-foreground" />
            Kunskapsbas (FAQ)
          </CardTitle>
          <CardDescription>
            Assistenten söker först i en kvalitetssäkrad svensk kunskapsbas med vanliga frågor om
            Nordklart och svensk bokföring. Hittar den inget säkert svar går den vidare till sina
            kunskapsområden i stället för att gissa.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {statusLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-5 w-64" />
            </div>
          ) : status ? (
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">Status</dt>
                <dd className="mt-1">
                  <Badge variant="secondary">Aktiverad</Badge>
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                  Indexerade frågor
                </dt>
                <dd className="mt-1 text-sm font-medium">
                  {status.indexed_entries} av {status.expected_entries}
                  {!status.db_seeded ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      (inbyggt dataset — databas-seed ej körd)
                    </span>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                  Senast inläst
                </dt>
                <dd className="mt-1 text-sm font-medium">
                  {status.last_seeded_at
                    ? formatDate(status.last_seeded_at)
                    : status.last_updated_at
                      ? formatDate(status.last_updated_at)
                      : '–'}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Status kunde inte hämtas.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Testa en fråga</CardTitle>
          <CardDescription>
            Skriv en fråga så ser du exakt vilket FAQ-svar assistenten skulle grunda sig på — med
            träffsäkerhet, källa och risknivå.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void runTest()
            }}
          >
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="T.ex. Hur kopplar jag banken?"
              maxLength={500}
            />
            <Button type="submit" disabled={testing || question.trim().length < 2}>
              {testing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              <span className="ml-2">Testa</span>
            </Button>
          </form>

          {result ? (
            result.low_confidence || result.matches.length === 0 ? (
              <div className="flex items-start gap-3 rounded-md border border-border bg-secondary/40 p-4">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="text-sm">
                  <p className="font-medium">Ingen säker träff</p>
                  <p className="mt-1 text-muted-foreground">
                    Kunskapsbasen har inget svar med tillräcklig träffsäkerhet på den här frågan.
                    Assistenten skulle i det här läget gå vidare till sina kunskapsområden — eller
                    säga ärligt att den inte vet — i stället för att gissa.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {result.matches.map((m, i) => (
                  <div key={m.id} className="rounded-md border border-border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={i === 0 && m.high_confidence ? 'default' : 'secondary'}>
                        {Math.round(m.confidence * 100)} % träff
                      </Badge>
                      <Badge variant="outline">{m.category}</Badge>
                      {m.risk_level !== 'low' ? (
                        <Badge variant="outline">{RISK_LABEL[m.risk_level]}</Badge>
                      ) : null}
                      <span className="ml-auto font-mono text-xs text-muted-foreground">{m.id}</span>
                    </div>
                    <p className="mt-3 text-sm font-medium">{m.short_answer_sv}</p>
                    {i === 0 ? (
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">{m.answer_sv}</p>
                    ) : null}
                    {m.escalation ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        <span className="font-medium">Eskalering:</span> {m.escalation}
                      </p>
                    ) : null}
                    {m.sources.length > 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        <span className="font-medium">Källor:</span> {m.sources.join(', ')}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            )
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
