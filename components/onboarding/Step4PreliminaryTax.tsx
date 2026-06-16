'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, ArrowRight, ArrowLeft, Calculator, SkipForward } from 'lucide-react'

const schema = z.object({
  preliminary_tax_monthly: z.number().min(0).optional().nullable(),
})

type FormData = z.infer<typeof schema>

interface Step4Props {
  initialData: Partial<FormData>
  onNext: (data: FormData) => void
  onBack: () => void
  onSkip: () => void
  isSaving: boolean
}

export default function Step4PreliminaryTax({
  initialData,
  onNext,
  onBack,
  onSkip,
  isSaving,
}: Step4Props) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: {
      preliminary_tax_monthly: initialData.preliminary_tax_monthly ?? undefined,
    },
  })

  const onSubmit = (data: FormData) => {
    onNext({
      preliminary_tax_monthly: data.preliminary_tax_monthly || null,
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calculator className="h-5 w-5" />
            Månatlig F-skatt
          </CardTitle>
          <CardDescription>
            Detta är frivilligt men hjälper oss visa varningar om du betalar för lite skatt.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit, (errs) => {
            const fields = Object.keys(errs).join(', ')
            console.error('[onboarding] step 4 validation failed:', fields, errs)
            fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'step 4 validation failed', extra: { fields } }) }).catch(() => {})
          })} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="preliminary_tax_monthly">
                Preliminärskatt per månad (kr)
              </Label>
              <Input
                id="preliminary_tax_monthly"
                type="number"
                placeholder="0"
                {...register('preliminary_tax_monthly', { valueAsNumber: true })}
              />
              {errors.preliminary_tax_monthly && (
                <p className="text-sm text-destructive">
                  {errors.preliminary_tax_monthly.message}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                Beloppet hittar du på ditt F-skattsedelsbeslut från Skatteverket.
              </p>
            </div>

            <div className="bg-muted/50 rounded-lg p-4">
              <h4 className="font-medium mb-2">Varför är detta användbart?</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Vi jämför din inbetalda skatt mot beräknad skatt</li>
                <li>• Du får varningar om du riskerar restskatt</li>
                <li>• Lättare att planera för slutskattebeskedet</li>
              </ul>
            </div>

            <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-3 pt-4">
              <Button
                type="button"
                variant="ghost"
                onClick={onBack}
                disabled={isSaving}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Tillbaka
              </Button>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={onSkip}
                  disabled={isSaving}
                  className="w-full sm:w-auto"
                >
                  <SkipForward className="mr-2 h-4 w-4" />
                  Hoppa över
                </Button>
                <Button type="submit" disabled={isSaving} className="w-full sm:w-auto">
                  {isSaving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sparar...
                    </>
                  ) : (
                    <>
                      Fortsätt
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
