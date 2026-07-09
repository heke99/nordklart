import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { ensureInitialized } from '@/lib/init'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { eventBus } from '@/lib/events/bus'
import { extractTextContent, extractNestedText } from '@/lib/import/bank-file/formats/camt-shared'
import { createLogger } from '@/lib/logger'

ensureInitialized()

const log = createLogger('peppol-inbound')

/**
 * POST /api/peppol/inbound — inbound e-invoice webhook (access point → us).
 *
 * Auth: shared secret in the X-Peppol-Inbound-Secret header, compared
 * constant-time against PEPPOL_INBOUND_SECRET. The access-point provider is
 * configured with this URL + secret when the Peppol agreement is set up.
 *
 * Body: { company_id, ubl_xml } — the receiving company and the raw UBL.
 * The UBL is archived verbatim as a WORM document (BFL 7 kap — it is the
 * received underlag), an e_invoice_deliveries row records the receipt, and
 * peppol_invoice.received fans out to webhooks so downstream automation can
 * pick it up (invoice-inbox conversion is a manual/agent step from there).
 */
export async function POST(request: Request) {
  const configured = process.env.PEPPOL_INBOUND_SECRET
  if (!configured) {
    return NextResponse.json(
      { error: 'Peppol inbound är inte konfigurerat (PEPPOL_INBOUND_SECRET saknas).' },
      { status: 503 },
    )
  }
  const presented = request.headers.get('x-peppol-inbound-secret') ?? ''
  const a = Buffer.from(presented)
  const b = Buffer.from(configured)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { company_id?: string; ubl_xml?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body is not valid JSON.' }, { status: 400 })
  }
  if (!body.company_id || !body.ubl_xml || body.ubl_xml.length < 50) {
    return NextResponse.json({ error: 'company_id och ubl_xml krävs.' }, { status: 400 })
  }

  const supabase = createServiceClientNoCookies()

  // Verify the company exists (the secret authenticates the ACCESS POINT,
  // not the tenant — reject unknown tenants explicitly).
  const { data: company } = await supabase
    .from('companies')
    .select('id, created_by')
    .eq('id', body.company_id)
    .maybeSingle()
  if (!company) {
    return NextResponse.json({ error: 'Okänt företag.' }, { status: 404 })
  }
  const systemUserId = (company as { created_by: string }).created_by

  // Extract display metadata from the UBL (best-effort — the verbatim XML
  // is the source of truth and is archived regardless).
  const supplierName =
    extractNestedText(body.ubl_xml, 'AccountingSupplierParty', 'Name') ?? null
  const invoiceNumber = extractTextContent(body.ubl_xml, 'cbc:ID') ?? 'okänt'

  // Replay protection FIRST (access-point deliveries are at-least-once):
  // the delivery row is claimed via the unique (company, content) index
  // before any side effect, so a redelivered invoice can never archive a
  // second WORM document or fan out a second event.
  const contentSha256 = crypto.createHash('sha256').update(body.ubl_xml).digest('hex')

  const { data: delivery, error: insertErr } = await supabase
    .from('e_invoice_deliveries')
    .insert({
      company_id: body.company_id,
      direction: 'inbound',
      provider: 'access_point',
      status: 'received',
      ubl_xml: body.ubl_xml,
      content_sha256: contentSha256,
      metadata: {
        supplier_name: supplierName,
        invoice_number: invoiceNumber,
        document_id: null,
      },
    })
    .select('id')
    .single()

  if (insertErr) {
    if ((insertErr as { code?: string }).code === '23505') {
      const { data: existing } = await supabase
        .from('e_invoice_deliveries')
        .select('id')
        .eq('company_id', body.company_id)
        .eq('direction', 'inbound')
        .eq('content_sha256', contentSha256)
        .maybeSingle()
      log.info('inbound delivery replay acknowledged', { companyId: body.company_id })
      return NextResponse.json({
        data: { delivery_id: (existing as { id: string } | null)?.id ?? null, duplicate: true },
      })
    }
    log.error('inbound delivery insert failed', insertErr, { companyId: body.company_id })
    return NextResponse.json({ error: 'Kunde inte registrera e-fakturan.' }, { status: 500 })
  }

  const deliveryId = (delivery as { id: string }).id

  // Archive the UBL as a WORM document (after the claim — replays can no
  // longer reach this point).
  let documentId: string | null = null
  try {
    const buffer = new TextEncoder().encode(body.ubl_xml).buffer as ArrayBuffer
    const doc = await uploadDocument(
      supabase,
      systemUserId,
      body.company_id,
      {
        name: `peppol-inkommande-${invoiceNumber}-${Date.now()}.xml`,
        buffer,
        type: 'application/xml',
      },
      { upload_source: 'e_invoice' },
    )
    documentId = doc.id
    await supabase
      .from('e_invoice_deliveries')
      .update({
        metadata: {
          supplier_name: supplierName,
          invoice_number: invoiceNumber,
          document_id: documentId,
        },
      })
      .eq('id', deliveryId)
  } catch (err) {
    log.error('inbound UBL archive failed', err as Error, { companyId: body.company_id })
  }
  try {
    await eventBus.emit({
      type: 'peppol_invoice.received',
      payload: {
        deliveryId,
        supplierName,
        userId: systemUserId,
        companyId: body.company_id,
      },
    })
  } catch {
    // Best-effort.
  }

  return NextResponse.json({ data: { delivery_id: deliveryId, document_id: documentId } })
}
