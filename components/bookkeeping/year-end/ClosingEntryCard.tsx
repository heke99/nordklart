'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import JournalEntryForm from '@/components/bookkeeping/JournalEntryForm'
import { useCompany } from '@/contexts/CompanyContext'

/**
 * Bokslutsverifikationer: corrections and additions found while closing the
 * year (a missed supplier invoice, an accrual, a wrongly booked cost). They
 * are ordinary verifikationer dated on the balance sheet date, so they belong
 * to the year being closed and appear in its reports and annual report. A
 * posted entry is never edited: a mistake in one is fixed with "Rätta" on the
 * entry itself, which books a reversal and a new entry (BFL 5 kap. 5 §).
 */
export default function ClosingEntryCard({ periodEnd, onBooked }: { periodEnd: string; onBooked?: () => void }) {
  const { canWrite } = useCompany()
  const [open, setOpen] = useState(false)
  const [formKey, setFormKey] = useState(0)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Bokslutsverifikationer och rättelser</CardTitle>
        <p className="text-sm text-muted-foreground">
          Hittar du fel eller saknade poster under bokslutet bokför du dem här, daterade på balansdagen {periodEnd}, innan
          året stängs. En redan bokförd verifikation ändras aldrig: öppna den och välj Rätta, så bokförs en
          omvändning och en ny verifikation med spårbarhet till originalet.
        </p>
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={() => setOpen(true)} disabled={!canWrite}>
          <Plus className="mr-2 h-4 w-4" />
          Ny bokslutsverifikation
        </Button>
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Ny bokslutsverifikation</DialogTitle>
            <DialogDescription>
              Daterad {periodEnd}. Bifoga underlaget, till exempel fakturan, beräkningen eller avstämningen som visar felet.
            </DialogDescription>
          </DialogHeader>
          <JournalEntryForm
            key={formKey}
            initialDate={periodEnd}
            onCreated={() => {
              setOpen(false)
              setFormKey((k) => k + 1)
              onBooked?.()
            }}
          />
        </DialogContent>
      </Dialog>
    </Card>
  )
}
