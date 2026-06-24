import { redirect } from 'next/navigation'

type SearchParams = Record<string, string | string[] | undefined>

export default async function NewExpensePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue
    if (Array.isArray(value)) value.forEach((item) => qs.append(key, item))
    else qs.set(key, value)
  }
  qs.set('paid_with_private_funds', 'true')
  redirect(`/supplier-invoices/new?${qs.toString()}`)
}
