/**
 * /api/v1/companies/{companyId}/articles/{id} — article detail + writes.
 *
 * GET    — full record.
 * PATCH  — partial update (incl. active flag for archive/unarchive).
 * DELETE — soft-archive (active=false). 204. Idempotent.
 */
import { z } from 'zod'
import { noContent, ok } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { UpdateArticleSchema } from '@/lib/api/schemas'
import { eventBus } from '@/lib/events'
import type { Article } from '@/types'

const ArticleDetail = z.object({
  id: z.string().uuid(),
  article_number: z.string().nullable(),
  name: z.string(),
  name_en: z.string().nullable(),
  type: z.enum(['vara', 'tjanst']),
  unit: z.string(),
  price_excl_vat: z.number(),
  vat_rate: z.number(),
  revenue_account: z.string().nullable(),
  cost_price: z.number().nullable(),
  ean: z.string().nullable(),
  housework_type: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
})

const ARTICLE_COLUMNS =
  'id, article_number, name, name_en, type, unit, price_excl_vat, vat_rate, revenue_account, cost_price, ean, housework_type, notes, active, created_at, updated_at'

registerEndpoint({
  operation: 'articles.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/articles/:id',
  summary: 'Retrieve a single article.',
  description: 'Returns the full article record, including archived articles.',
  useWhen: 'You need full article data before updating or invoicing.',
  doNotUseFor: 'Listing (use the list endpoint).',
  pitfalls: ['Archived articles (active=false) are still readable by id.'],
  example: {
    response: {
      data: { id: 'a1b2…', name: 'Konsulttimme', vat_rate: 25, active: true },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'articles:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: ArticleDetail },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'articles.get',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Article id must be a UUID.' },
      })
    }

    const { data, error } = await ctx.supabase
      .from('articles')
      .select(ARTICLE_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .maybeSingle()

    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    if (!data) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'article' },
      })
    }
    return ok(data, { requestId: ctx.requestId })
  },
)

registerEndpoint({
  operation: 'articles.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/articles/:id',
  summary: 'Update an article.',
  description:
    'Partial update. Set active=false to archive / active=true to restore. Existing invoice lines keep their frozen article snapshot — updating an article never re-books history.',
  useWhen: 'Price changes, renames, archiving.',
  doNotUseFor: 'Editing historical invoice lines (immutable).',
  pitfalls: ['vat_rate must remain statutory (0/6/12/25).'],
  example: {
    request: { price_excl_vat: 1300 },
    response: {
      data: { id: 'a1b2…', price_excl_vat: 1300 },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'articles:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: false,
  request: { body: UpdateArticleSchema },
  response: { success: ArticleDetail },
})

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'articles.update',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Article id must be a UUID.' },
      })
    }

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = UpdateArticleSchema.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      })
    }
    if (Object.keys(parsed.data).length === 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'At least one field is required.' },
      })
    }

    const { data, error } = await ctx.supabase
      .from('articles')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .select(ARTICLE_COLUMNS)
      .maybeSingle()

    if (error) {
      if (error.code === '23505') {
        return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'article_number', message: 'Artikelnumret finns redan.' },
        })
      }
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'article' },
      })
    }

    await eventBus.emit({
      type: 'article.updated',
      payload: { article: data as unknown as Article, userId: ctx.userId, companyId: ctx.companyId! },
    })

    return ok(data, { requestId: ctx.requestId })
  },
)

registerEndpoint({
  operation: 'articles.archive',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/articles/:id',
  summary: 'Archive an article (soft delete).',
  description:
    'Sets active=false. The article stays queryable by id and referenced invoice lines keep their frozen snapshot. Restore via PATCH { active: true }.',
  useWhen: 'Retiring products/services from the catalogue.',
  doNotUseFor: 'Hard deletion — v1 never hard-deletes articles.',
  pitfalls: ['Idempotent: archiving an already-archived article returns 204.'],
  example: { response: {} },
  scope: 'articles:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: false,
  response: { success: z.object({}) },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'articles.archive',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Article id must be a UUID.' },
      })
    }

    const { data, error } = await ctx.supabase
      .from('articles')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .select('id')
      .maybeSingle()

    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    if (!data) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'article' },
      })
    }
    return noContent({ requestId: ctx.requestId })
  },
)
