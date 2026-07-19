'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataList, DataListEmpty } from '@/components/ui/data-list'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, FileInput, Lock, FileDown } from 'lucide-react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/page-header'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDate } from '@/lib/utils'
import type { SupplierInvoice } from '@/types'

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  registered: 'secondary',
  approved: 'default',
  paid: 'success',
  partially_paid: 'warning',
  overdue: 'destructive',
  disputed: 'warning',
  credited: 'secondary',
  reversed: 'secondary',
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  registered: 'status_registered',
  approved: 'status_approved',
  paid: 'status_paid',
  partially_paid: 'status_partially_paid',
  overdue: 'status_overdue',
  disputed: 'status_disputed',
  credited: 'status_credited',
  reversed: 'status_reversed',
}

export default function SupplierInvoicesPage() {
  const t = useTranslations('supplier_invoices')
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const [invoices, setInvoices] = useState<(SupplierInvoice & { supplier?: { id: string; name: string } })[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all')
  const [isGeneratingFile, setIsGeneratingFile] = useState(false)

  async function fetchInvoices() {
    setIsLoading(true)
    const res = await fetch('/api/supplier-invoices?status=all')
    const { data } = await res.json()
    setInvoices(data || [])
    setIsLoading(false)
  }

  useEffect(() => {
    // Defer to the next macrotask so the synchronous setState inside
    // fetchInvoices does not run directly within the effect body.
    const timer = setTimeout(() => {
      fetchInvoices()
    }, 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filteredInvoices = invoices.filter((inv) => {
    switch (activeTab) {
      case 'registered': return inv.status === 'registered'
      case 'approved': return inv.status === 'approved'
      case 'to_pay': return inv.status === 'approved' || inv.status === 'overdue'
      case 'paid': return inv.status === 'paid'
      default: return true
    }
  })

  // Payable SEK invoices — the set the pain.001 payment file covers.
  const payableInvoices = invoices.filter(
    (inv) => (inv.status === 'approved' || inv.status === 'overdue' || inv.status === 'partially_paid')
      && inv.remaining_amount > 0
      && inv.currency === 'SEK',
  )

  async function handleGeneratePaymentFile() {
    if (payableInvoices.length === 0) return
    setIsGeneratingFile(true)
    try {
      const res = await fetch('/api/supplier-invoices/payment-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier_invoice_ids: payableInvoices.map((inv) => inv.id),
          payment_date: new Date().toISOString().slice(0, 10),
        }),
      })
      const result = await res.json()
      if (!res.ok) {
        toast({
          title: t('payment_file_failed'),
          description: result?.error?.message || result?.error || '',
          variant: 'destructive',
        })
        return
      }
      // Trigger the download of the generated pain.001 file.
      const blob = new Blob([result.data.file.content], { type: 'application/xml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = result.data.file.filename
      a.click()
      URL.revokeObjectURL(url)
      toast({
        title: t('payment_file_created'),
        description: t('payment_file_created_description', {
          count: result.data.initiation.payment_count,
        }),
      })
    } catch {
      toast({ title: t('payment_file_failed'), variant: 'destructive' })
    } finally {
      setIsGeneratingFile(false)
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        action={
          canWrite ? (
            <div className="flex items-center gap-2">
              {payableInvoices.length > 0 && (
                <Button
                  variant="outline"
                  onClick={handleGeneratePaymentFile}
                  disabled={isGeneratingFile}
                  title={t('payment_file_tooltip')}
                >
                  <FileDown className="mr-2 h-4 w-4" />
                  {t('payment_file_button', { count: payableInvoices.length })}
                </Button>
              )}
              <Link href="/supplier-invoices/new">
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  {t('register_invoice')}
                </Button>
              </Link>
            </div>
          ) : (
            <Button
              disabled
              title={t('viewer_disabled_tooltip')}
            >
              <Lock className="mr-2 h-4 w-4" />
              {t('register_invoice')}
            </Button>
          )
        }
      />

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all">{t('tab_all')}</TabsTrigger>
          <TabsTrigger value="registered">{t('tab_registered')}</TabsTrigger>
          <TabsTrigger value="approved">{t('tab_approved')}</TabsTrigger>
          <TabsTrigger value="to_pay">{t('tab_to_pay')}</TabsTrigger>
          <TabsTrigger value="paid">{t('tab_paid')}</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab}>
          <DataList>
            {isLoading ? (
              <div>
                <div className="p-3 border-b border-border">
                  <Skeleton className="h-4 w-full" />
                </div>
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex items-center gap-4 p-3 border-b border-border last:border-0">
                    <Skeleton className="h-4 w-12" />
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-20  ml-auto" />
                    <Skeleton className="h-5 w-16" />
                  </div>
                ))}
              </div>
            ) : filteredInvoices.length === 0 ? (
              <DataListEmpty
                icon={<FileInput className="h-6 w-6" />}
                title={t('empty_title')}
                description={
                  activeTab === 'all'
                    ? t('empty_description_all')
                    : t('empty_description_category')
                }
                action={
                  activeTab === 'all' && canWrite ? (
                    <Button asChild>
                      <Link href="/supplier-invoices/new">{t('register_invoice')}</Link>
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('th_arrival')}</TableHead>
                    <TableHead>{t('th_supplier')}</TableHead>
                    <TableHead>{t('th_invoice_number')}</TableHead>
                    <TableHead>{t('th_invoice_date')}</TableHead>
                    <TableHead>{t('th_due_date')}</TableHead>
                    <TableHead className="text-right">{t('th_amount')}</TableHead>
                    <TableHead className="text-right">{t('th_remaining')}</TableHead>
                    <TableHead>{t('th_status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredInvoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-mono tabular-nums">{inv.arrival_number}</TableCell>
                      <TableCell>
                        <Link href={`/suppliers/${inv.supplier_id}`} className="hover:underline">
                          {inv.supplier?.name || '-'}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link href={`/supplier-invoices/${inv.id}`} className="text-primary hover:underline">
                          {inv.supplier_invoice_number}
                        </Link>
                      </TableCell>
                      <TableCell className="tabular-nums">{formatDate(inv.invoice_date)}</TableCell>
                      <TableCell className="tabular-nums">{formatDate(inv.due_date)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(inv.total)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(inv.remaining_amount)}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANTS[inv.status] || 'secondary'}>
                          {STATUS_LABEL_KEYS[inv.status] ? t(STATUS_LABEL_KEYS[inv.status]) : inv.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </DataList>
        </TabsContent>
      </Tabs>
    </div>
  )
}
