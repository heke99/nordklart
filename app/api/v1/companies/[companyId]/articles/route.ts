/**
 * /api/v1/companies/{companyId}/articles — artikelregister list + create.
 *
 * GET  — list with ?search / ?type / ?include_inactive filters. Cursor
 *        pagination on (created_at ASC, id ASC).
 * POST — create. Idempotent (Idempotency-Key). Dry-runnable.
 */
import { z } from 'zod'
import { created, paginated } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
} from '@/lib/api/v1/pagination'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { CreateArticleSchema } from '@/lib/api/schemas'
import { eventBus } from '@/lib/events'
import type { Article } from '@/types'

const ArticleSummary = z.object({
  id: z.string().uuid(),
  article_number: z.string().nullable(),
  name: z.string(),
  type: z.enum(['vara', 'tjanst']),
  unit: z.string(),
  price_excl_vat: z.number(),
  vat_rate: z.number(),
  revenue_account: z.string().nullable(),
  active: z.boolean(),
  created_at: z.string(),
})

const ARTICLE_COLUMNS =
  'id, article_number, name, name_en, type, unit, price_excl_vat, vat_rate, revenue_account, cost_price, ean, housework_type, notes, active, created_at, updated_at'

registerEndpoint({
  operation: 'articles.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/articles',
  summary: 'List articles (artikelregistret).',
  description:
    'Returns active articles in created-first order. Filter by ?type=vara|tjanst and ?search (name/article_number). Pass ?include_inactive=true to include archived articles.',
  useWhen:
    'You need the product/service catalogue to build invoice lines or sync to an external system.',
  doNotUseFor:
    'Invoice line creation itself — pass the article data on POST /invoices items.',
  pitfalls: [
    'vat_rate is an integer percent (0/6/12/25).',
    'price_excl_vat is the list price excluding VAT in SEK.',
  ],
  example: {
    response: {
      data: [
        {
          id: 'a1b2…',
          article_number: 'K-100',
          name: 'Konsulttimme',
          type: 'tjanst',
          unit: 'tim',
          price_excl_vat: 1200,
          vat_rate: 25,
          active: true,
          created_at: '2026-01-10T09:00:00Z',
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'articles:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: z.object({ articles: z.array(ArticleSummary) }) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'articles.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const Filters = z.object({
      type: z.enum(['vara', 'tjanst']).optional(),
      search: z.string().min(1).max(200).optional(),
      include_inactive: z.enum(['true', 'false']).optional(),
    })
    const parsed = Filters.safeParse({
      type: url.searchParams.get('type') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
      include_inactive: url.searchParams.get('include_inactive') ?? undefined,
    })
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      })
    }
    const filters = parsed.data

    let query = ctx.supabase
      .from('articles')
      .select(ARTICLE_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1)

    if (filters.include_inactive !== 'true') query = query.eq('active', true)
    if (filters.type) query = query.eq('type', filters.type)
    if (filters.search) {
      const safe = filters.search.replace(/[,()]/g, ' ').replace(/[%_\\]/g, '\\$&').trim()
      if (safe.length > 0) {
        query = query.or(`name.ilike.%${safe}%,article_number.ilike.%${safe}%`)
      }
    }
    if (decoded) {
      query = query.or(
        `created_at.gt.${decoded.ts},and(created_at.eq.${decoded.ts},id.gt.${decoded.id})`,
      )
    }

    const { data, error } = await query
    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })

    const rows = (data ?? []) as unknown as Article[]
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const nextCursor = hasMore && last ? encodeDefaultCursor(last) : null

    return paginated(page, { requestId: ctx.requestId, nextCursor: nextCursor ?? undefined })
  },
)

registerEndpoint({
  operation: 'articles.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/articles',
  summary: 'Create an article.',
  description:
    'Creates an article in the artikelregister. vat_rate must be a statutory Swedish rate (0/6/12/25). article_number is unique per company when provided.',
  useWhen: 'Syncing a product catalogue into Nordklart or creating reusable invoice lines.',
  doNotUseFor: 'One-off invoice lines — pass them directly on invoice creation.',
  pitfalls: [
    'Duplicate article_number for the company returns CONFLICT.',
    'revenue_account must be a 4-digit BAS class-3 account when provided.',
  ],
  example: {
    request: {
      name: 'Konsulttimme',
      type: 'tjanst',
      unit: 'tim',
      price_excl_vat: 1200,
      vat_rate: 25,
      article_number: 'K-100',
    },
    response: {
      data: { id: 'a1b2…', name: 'Konsulttimme', vat_rate: 25, active: true },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'articles:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateArticleSchema },
  response: { success: ArticleSummary },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'articles.create',
  async (request, ctx) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = CreateArticleSchema.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      })
    }
    const input = parsed.data

    if (ctx.dryRun) {
      return dryRunPreview(
        { ...input, active: true },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const { data: article, error } = await ctx.supabase
      .from('articles')
      .insert({
        company_id: ctx.companyId!,
        user_id: ctx.userId,
        name: input.name,
        name_en: input.name_en ?? null,
        type: input.type ?? 'tjanst',
        unit: input.unit ?? 'st',
        price_excl_vat: input.price_excl_vat,
        vat_rate: input.vat_rate ?? 25,
        revenue_account: input.revenue_account ?? null,
        cost_price: input.cost_price ?? null,
        ean: input.ean ?? null,
        housework_type: input.housework_type ?? null,
        notes: input.notes ?? null,
        article_number: input.article_number ?? null,
      })
      .select(ARTICLE_COLUMNS)
      .single()

    if (error) {
      if (error.code === '23505') {
        return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'article_number', message: 'Artikelnumret finns redan.' },
        })
      }
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    await eventBus.emit({
      type: 'article.created',
      payload: {
        article: article as Article,
        userId: ctx.userId,
        companyId: ctx.companyId!,
      },
    })

    return created(article, { requestId: ctx.requestId })
  },
)
