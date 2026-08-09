import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { backendPid, getPool, openServiceRoleTx, waitUntilBlocked, withServiceRole } from './setup'
import { seedCompany } from './fixtures'

/**
 * Stripe one-time purchase lifecycle, end to end and out of order.
 *
 * Stripe delivers at-least-once, retries on any non-2xx, and makes no ordering
 * guarantee. Every one of those is a way to corrupt an entitlement: a retried
 * `checkout.session.completed` can grant twice, a late-arriving stale event can
 * resurrect access after a refund revoked it, and a dispute followed by its own
 * retry can flip access back and forth.
 *
 * These tests drive the same RPCs the webhook route calls in production
 * (stripe_finalize_checkout_v2 + stripe_apply_one_time_purchase_event) rather
 * than the route itself, so the invariants are pinned where they are enforced.
 */

async function activePlanVersion(planCode: string) {
  const { rows } = await getPool().query<{ version_id: string; product_id: string }>(
    `SELECT pv.id AS version_id, pr.id AS product_id
     FROM platform_plan_versions pv
     JOIN platform_price_plans pp ON pp.id = pv.plan_id
     JOIN platform_products pr ON pr.id = pp.product_id
     WHERE pp.code = $1 AND pv.status = 'active'
     ORDER BY pv.version_number DESC LIMIT 1`,
    [planCode],
  )
  expect(rows).toHaveLength(1)
  return { versionId: rows[0].version_id, productId: rows[0].product_id }
}

interface Checkout {
  companyId: string
  fiscalPeriodId: string
  sessionId: string
  versionId: string
}

async function openCheckout(): Promise<Checkout> {
  const seeded = await seedCompany()
  const { versionId } = await activePlanVersion('year_end_one_time')
  const sessionId = `cs_test_${randomUUID()}`
  await getPool().query(
    `INSERT INTO public.billing_checkout_sessions
       (company_id, plan_version_id, checkout_kind, fiscal_period_id,
        stripe_checkout_session_id, status, amount_excl_vat)
     VALUES ($1, $2, 'one_time', $3, $4, 'open', 990)`,
    [seeded.companyId, versionId, seeded.fiscalPeriodId, sessionId],
  )
  return {
    companyId: seeded.companyId,
    fiscalPeriodId: seeded.fiscalPeriodId,
    sessionId,
    versionId,
  }
}

async function finalizeCheckout(params: {
  sessionId: string
  eventId?: string
  paymentStatus?: string
  grossMinor?: number
}) {
  return withServiceRole((client) => client.query(
    `SELECT public.stripe_finalize_checkout_v2($1, $2, $3, null, $4, $5, 24750, 123750, 'sek', null)`,
    [
      params.eventId ?? `evt_${randomUUID()}`,
      params.sessionId,
      `cus_test_${randomUUID()}`,
      params.paymentStatus ?? 'paid',
      params.grossMinor ?? 99000,
    ],
  ))
}

interface LifecycleResult {
  applied: boolean
  reason?: string
  duplicate?: boolean
  purchase_id?: string
  status?: string
  payment_status?: string
  gross_paid_minor?: number
  refunded_minor?: number
  access_revoked_at?: string | null
  revocation_reason?: string | null
  stale_event?: boolean
}

interface LifecycleEvent {
  eventId?: string
  type: string
  createdAt?: string
  checkoutSessionId?: string | null
  paymentIntentId?: string | null
  chargeId?: string | null
  refundId?: string | null
  paymentStatus?: string | null
  grossMinor?: number | null
  refundedMinor?: number | null
  disputeStatus?: string | null
}

const LIFECYCLE_SQL = `SELECT public.stripe_apply_one_time_purchase_event(
  $1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9::bigint, $10::bigint, 'sek', $11
) AS result`

function lifecycleParams(event: LifecycleEvent) {
  return [
    event.eventId ?? `evt_${randomUUID()}`,
    event.type,
    event.createdAt ?? '2026-05-01T10:00:00Z',
    event.checkoutSessionId ?? null,
    event.paymentIntentId ?? null,
    event.chargeId ?? null,
    event.refundId ?? null,
    event.paymentStatus ?? null,
    event.grossMinor ?? null,
    event.refundedMinor ?? null,
    event.disputeStatus ?? null,
  ]
}

async function applyEvent(event: LifecycleEvent): Promise<LifecycleResult> {
  return withServiceRole(async (client) => {
    const { rows } = await client.query<{ result: LifecycleResult }>(
      LIFECYCLE_SQL, lifecycleParams(event),
    )
    return rows[0].result
  })
}

async function purchaseFor(companyId: string, fiscalPeriodId: string) {
  const { rows } = await getPool().query<{
    id: string; status: string; payment_status: string | null
    gross_paid_minor: string; refunded_minor: string
    access_revoked_at: string | null; revocation_reason: string | null
    fiscal_period_id: string | null; product_id: string; purchase_type: string
    last_stripe_event_id: string | null
  }>(
    `SELECT id, status, payment_status, gross_paid_minor::text, refunded_minor::text,
            access_revoked_at::text, revocation_reason, fiscal_period_id, product_id,
            purchase_type, last_stripe_event_id
     FROM public.one_time_purchases
     WHERE company_id = $1 AND fiscal_period_id = $2 AND purchase_type = 'year_end'`,
    [companyId, fiscalPeriodId],
  )
  return rows
}

async function billingEventCount(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM public.billing_events WHERE company_id = $1`,
    [companyId],
  )
  return Number(rows[0].count)
}

describe('Stripe checkout completion', () => {
  it('creates exactly one purchase and is idempotent across retries', async () => {
    const checkout = await openCheckout()
    const eventId = `evt_${randomUUID()}`

    await finalizeCheckout({ sessionId: checkout.sessionId, eventId })
    // Stripe retries the identical delivery after a timeout.
    await finalizeCheckout({ sessionId: checkout.sessionId, eventId })
    // And redelivers under a fresh event id, which is also a real Stripe shape.
    await finalizeCheckout({ sessionId: checkout.sessionId })

    const purchases = await purchaseFor(checkout.companyId, checkout.fiscalPeriodId)
    expect(purchases).toHaveLength(1)
    expect(purchases[0].status).toBe('paid')
  })

  it('creates nothing for an unpaid checkout', async () => {
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId, paymentStatus: 'unpaid' })
    expect(await purchaseFor(checkout.companyId, checkout.fiscalPeriodId)).toHaveLength(0)
  })

  it('binds the purchase to product, company and fiscal period', async () => {
    // The critical invariant: a period-bound product must never become a
    // company-wide pass. A purchase that lost its fiscal_period_id would
    // silently unlock every year the company has.
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId })

    const purchases = await purchaseFor(checkout.companyId, checkout.fiscalPeriodId)
    expect(purchases).toHaveLength(1)
    expect(purchases[0].fiscal_period_id).toBe(checkout.fiscalPeriodId)
    expect(purchases[0].purchase_type).toBe('year_end')

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.one_time_purchases
       WHERE company_id = $1 AND fiscal_period_id IS NULL`,
      [checkout.companyId],
    )
    expect(rows[0].count).toBe('0')
  })
})

describe('Stripe event idempotency', () => {
  it('applies a lifecycle event once and replays the stored result', async () => {
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId })
    const eventId = `evt_${randomUUID()}`
    const event: LifecycleEvent = {
      eventId,
      type: 'checkout.session.completed',
      checkoutSessionId: checkout.sessionId,
      paymentStatus: 'paid',
      grossMinor: 99000,
    }

    const first = await applyEvent(event)
    expect(first.applied).toBe(true)

    // The exact same provider event id, twice. The second delivery replays the
    // STORED result rather than re-applying, so it is byte-identical to the
    // first — the same canonical-replay contract the settlement RPCs use. A
    // `duplicate: true` marker only surfaces when the original application
    // crashed before its result was recorded.
    const replay = await applyEvent(event)
    expect(replay).toEqual(first)

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.stripe_one_time_event_applications
       WHERE stripe_event_id = $1`,
      [eventId],
    )
    expect(rows[0].count).toBe('1')
  })

  it('reports purchase_not_found for an event with no local purchase', async () => {
    // Refund and dispute events can outrun the checkout event that creates the
    // purchase. The route turns this into a deliberate failure so Stripe
    // retries, rather than marking an economically relevant event processed.
    const result = await applyEvent({
      type: 'charge.refunded',
      chargeId: `ch_${randomUUID()}`,
      refundedMinor: 100,
    })
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('purchase_not_found')
  })
})

describe('Stripe refunds', () => {
  it('keeps access on a partial refund and revokes it on a full one', async () => {
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId })
    const chargeId = `ch_${randomUUID()}`

    await applyEvent({
      type: 'checkout.session.completed',
      checkoutSessionId: checkout.sessionId,
      chargeId,
      paymentStatus: 'paid',
      grossMinor: 99000,
      createdAt: '2026-05-01T10:00:00Z',
    })

    const partial = await applyEvent({
      type: 'refund.created',
      chargeId,
      refundId: `re_${randomUUID()}`,
      refundedMinor: 20000,
      paymentStatus: 'succeeded',
      createdAt: '2026-05-02T10:00:00Z',
    })
    expect(partial.applied).toBe(true)
    expect(Number(partial.refunded_minor)).toBe(20000)
    // Documented policy: access is retained until the refund is full.
    expect(partial.status).not.toBe('refunded')
    expect(partial.access_revoked_at).toBeNull()

    const rest = await applyEvent({
      type: 'refund.created',
      chargeId,
      refundId: `re_${randomUUID()}`,
      refundedMinor: 79000,
      paymentStatus: 'succeeded',
      createdAt: '2026-05-03T10:00:00Z',
    })
    // Two partial refunds must SUM rather than overwrite — the bug a
    // GREATEST() over a single amount would produce.
    expect(Number(rest.refunded_minor)).toBe(99000)
    expect(rest.status).toBe('refunded')
    expect(rest.access_revoked_at).not.toBeNull()
    expect(rest.revocation_reason).toBe('stripe_full_refund')
  })

  it('does not double count a refund whose event is redelivered', async () => {
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId })
    const chargeId = `ch_${randomUUID()}`
    const refundId = `re_${randomUUID()}`

    await applyEvent({
      type: 'checkout.session.completed',
      checkoutSessionId: checkout.sessionId,
      chargeId,
      paymentStatus: 'paid',
      grossMinor: 99000,
    })

    const first = await applyEvent({
      type: 'refund.created',
      chargeId,
      refundId,
      refundedMinor: 40000,
      paymentStatus: 'succeeded',
      createdAt: '2026-05-02T10:00:00Z',
    })
    expect(Number(first.refunded_minor)).toBe(40000)

    // Same refund id, new event id: refund.updated for an unchanged refund.
    const second = await applyEvent({
      type: 'refund.updated',
      chargeId,
      refundId,
      refundedMinor: 40000,
      paymentStatus: 'succeeded',
      createdAt: '2026-05-02T11:00:00Z',
    })
    expect(Number(second.refunded_minor)).toBe(40000)
    expect(second.status).not.toBe('refunded')
  })

  it('ignores a refund that never succeeded', async () => {
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId })
    const chargeId = `ch_${randomUUID()}`

    await applyEvent({
      type: 'checkout.session.completed',
      checkoutSessionId: checkout.sessionId,
      chargeId,
      paymentStatus: 'paid',
      grossMinor: 99000,
    })

    const failed = await applyEvent({
      type: 'refund.failed',
      chargeId,
      refundId: `re_${randomUUID()}`,
      refundedMinor: 99000,
      paymentStatus: 'failed',
      createdAt: '2026-05-02T10:00:00Z',
    })
    // A failed refund must not revoke access — only successful rows sum.
    expect(failed.status).not.toBe('refunded')
    expect(failed.access_revoked_at).toBeNull()
  })
})

describe('Stripe disputes', () => {
  it('revokes on dispute created and restores when the dispute is won', async () => {
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId })
    const chargeId = `ch_${randomUUID()}`

    await applyEvent({
      type: 'checkout.session.completed',
      checkoutSessionId: checkout.sessionId,
      chargeId,
      paymentStatus: 'paid',
      grossMinor: 99000,
    })

    const opened = await applyEvent({
      type: 'charge.dispute.created',
      chargeId,
      disputeStatus: 'needs_response',
      createdAt: '2026-05-02T10:00:00Z',
    })
    expect(opened.status).toBe('cancelled')
    expect(opened.access_revoked_at).not.toBeNull()
    expect(opened.revocation_reason).toBe('stripe_dispute_open')

    const won = await applyEvent({
      type: 'charge.dispute.closed',
      chargeId,
      disputeStatus: 'won',
      createdAt: '2026-05-03T10:00:00Z',
    })
    expect(won.access_revoked_at).toBeNull()
    expect(won.revocation_reason).toBeNull()
    expect(won.status).not.toBe('cancelled')
  })

  it('keeps access revoked when the dispute is lost', async () => {
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId })
    const chargeId = `ch_${randomUUID()}`

    await applyEvent({
      type: 'checkout.session.completed',
      checkoutSessionId: checkout.sessionId,
      chargeId,
      paymentStatus: 'paid',
      grossMinor: 99000,
    })
    await applyEvent({
      type: 'charge.dispute.created',
      chargeId,
      disputeStatus: 'needs_response',
      createdAt: '2026-05-02T10:00:00Z',
    })
    const lost = await applyEvent({
      type: 'charge.dispute.closed',
      chargeId,
      disputeStatus: 'lost',
      createdAt: '2026-05-03T10:00:00Z',
    })
    expect(lost.status).toBe('cancelled')
    expect(lost.access_revoked_at).not.toBeNull()
    expect(lost.revocation_reason).toBe('stripe_dispute_lost')
  })

  it('does not let a won dispute resurrect access after a full refund', async () => {
    // Ordering trap: refunded money is gone regardless of who won the dispute.
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId })
    const chargeId = `ch_${randomUUID()}`

    await applyEvent({
      type: 'checkout.session.completed',
      checkoutSessionId: checkout.sessionId,
      chargeId,
      paymentStatus: 'paid',
      grossMinor: 99000,
    })
    await applyEvent({
      type: 'refund.created',
      chargeId,
      refundId: `re_${randomUUID()}`,
      refundedMinor: 99000,
      paymentStatus: 'succeeded',
      createdAt: '2026-05-02T10:00:00Z',
    })
    const won = await applyEvent({
      type: 'charge.dispute.closed',
      chargeId,
      disputeStatus: 'won',
      createdAt: '2026-05-03T10:00:00Z',
    })

    expect(won.status).toBe('refunded')
    expect(won.access_revoked_at).not.toBeNull()
  })
})

describe('Stripe out-of-order and stale events', () => {
  it('does not let an older event overwrite newer lifecycle state', async () => {
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId })
    const chargeId = `ch_${randomUUID()}`

    await applyEvent({
      type: 'checkout.session.completed',
      checkoutSessionId: checkout.sessionId,
      chargeId,
      paymentStatus: 'paid',
      grossMinor: 99000,
      createdAt: '2026-05-01T10:00:00Z',
    })
    const newestEventId = `evt_${randomUUID()}`
    const newest = await applyEvent({
      eventId: newestEventId,
      type: 'charge.dispute.created',
      chargeId,
      disputeStatus: 'needs_response',
      createdAt: '2026-05-05T10:00:00Z',
    })
    expect(newest.status).toBe('cancelled')

    // A delayed delivery from BEFORE the dispute now arrives.
    const staleEventId = `evt_${randomUUID()}`
    const stale = await applyEvent({
      eventId: staleEventId,
      type: 'checkout.session.completed',
      checkoutSessionId: checkout.sessionId,
      chargeId,
      paymentStatus: 'paid',
      grossMinor: 99000,
      createdAt: '2026-05-02T10:00:00Z',
    })
    expect(stale.stale_event).toBe(true)

    const purchases = await purchaseFor(checkout.companyId, checkout.fiscalPeriodId)
    // The stale event must not roll the state or the event pointer back: the
    // purchase still points at the dispute, not at the late arrival.
    expect(purchases[0].access_revoked_at).not.toBeNull()
    expect(purchases[0].status).toBe('cancelled')
    expect(purchases[0].last_stripe_event_id).toBe(newestEventId)
    expect(purchases[0].last_stripe_event_id).not.toBe(staleEventId)
  })

  it('treats a repeated final-state event as a no-op', async () => {
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId })
    const chargeId = `ch_${randomUUID()}`

    await applyEvent({
      type: 'checkout.session.completed',
      checkoutSessionId: checkout.sessionId,
      chargeId,
      paymentStatus: 'paid',
      grossMinor: 99000,
    })
    const refundId = `re_${randomUUID()}`
    const first = await applyEvent({
      type: 'refund.created',
      chargeId,
      refundId,
      refundedMinor: 99000,
      paymentStatus: 'succeeded',
      createdAt: '2026-05-02T10:00:00Z',
    })
    expect(first.status).toBe('refunded')

    const again = await applyEvent({
      type: 'refund.updated',
      chargeId,
      refundId,
      refundedMinor: 99000,
      paymentStatus: 'succeeded',
      createdAt: '2026-05-02T12:00:00Z',
    })
    expect(again.status).toBe('refunded')
    expect(Number(again.refunded_minor)).toBe(99000)
    expect(again.revocation_reason).toBe('stripe_full_refund')
  })

  it('marks an async payment failure without granting access', async () => {
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId })

    const failed = await applyEvent({
      type: 'checkout.session.async_payment_failed',
      checkoutSessionId: checkout.sessionId,
      paymentStatus: 'unpaid',
      createdAt: '2026-05-02T10:00:00Z',
    })
    expect(failed.applied).toBe(true)

    const { rows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.billing_checkout_sessions WHERE stripe_checkout_session_id = $1`,
      [checkout.sessionId],
    )
    expect(rows[0].status).toBe('failed')
  })
})

describe('Stripe concurrency', () => {
  it('serializes two deliveries of the same event and applies it once', async () => {
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId })
    const chargeId = `ch_${randomUUID()}`
    const eventId = `evt_${randomUUID()}`
    const event: LifecycleEvent = {
      eventId,
      type: 'refund.created',
      chargeId,
      refundId: `re_${randomUUID()}`,
      refundedMinor: 50000,
      paymentStatus: 'succeeded',
      createdAt: '2026-05-02T10:00:00Z',
    }

    await applyEvent({
      type: 'checkout.session.completed',
      checkoutSessionId: checkout.sessionId,
      chargeId,
      paymentStatus: 'paid',
      grossMinor: 99000,
    })

    const first = await openServiceRoleTx()
    const second = await openServiceRoleTx()
    let firstResult: LifecycleResult | undefined
    let secondResult: LifecycleResult | undefined
    try {
      const { rows } = await first.client.query<{ result: LifecycleResult }>(
        LIFECYCLE_SQL, lifecycleParams(event),
      )
      firstResult = rows[0].result
      expect(firstResult.applied).toBe(true)

      // The same webhook delivered twice in parallel — Stripe does this on a
      // slow response. The purchase row lock must hold the second until the
      // first resolves, or both would apply the refund.
      const secondPid = await backendPid(second.client)
      const secondCall = second.client.query<{ result: LifecycleResult }>(
        LIFECYCLE_SQL, lifecycleParams(event),
      )
      expect(await waitUntilBlocked(secondPid)).toBe(true)

      await first.commit()
      secondResult = (await secondCall).rows[0].result
      await second.commit()
    } finally {
      await first.rollback()
      await second.rollback()
    }

    // Same canonical replay as the sequential case: the loser returns the
    // winner's stored result, so the refund lands exactly once.
    expect(secondResult).toEqual(firstResult)

    const purchases = await purchaseFor(checkout.companyId, checkout.fiscalPeriodId)
    expect(Number(purchases[0].refunded_minor)).toBe(50000)

    const { rows: applications } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.stripe_one_time_event_applications
       WHERE stripe_event_id = $1`,
      [eventId],
    )
    expect(applications[0].count).toBe('1')
  })

  it('records one billing_events row per applied event, not per delivery', async () => {
    const checkout = await openCheckout()
    await finalizeCheckout({ sessionId: checkout.sessionId })
    const eventId = `evt_${randomUUID()}`
    const event: LifecycleEvent = {
      eventId,
      type: 'checkout.session.completed',
      checkoutSessionId: checkout.sessionId,
      paymentStatus: 'paid',
      grossMinor: 99000,
    }

    const before = await billingEventCount(checkout.companyId)
    await applyEvent(event)
    await applyEvent(event)
    await applyEvent(event)
    const after = await billingEventCount(checkout.companyId)

    expect(after - before).toBe(1)
  })
})
