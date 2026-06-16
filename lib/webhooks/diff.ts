/**
 * Compute previous_attributes for update-style webhook events.
 *
 * Stripe pattern: when an entity changes, the webhook payload carries the
 * NEW state in `data.object` and a `previous_attributes` field that holds
 * ONLY the fields whose values changed, with their PRIOR values. This lets
 * receivers diff without an extra GET round-trip.
 *
 * We compute this from a (priorRow, currentRow) pair captured by the route
 * handler before/after its mutation. A field is considered "changed" if
 * the JSON-serialised values differ.
 *
 * Phase 6 PR-1 only emits this for events that fundamentally describe
 * mutations of an existing resource (invoice.paid, supplier_invoice.paid,
 * supplier_invoice.approved, period.locked, period.unlocked,
 * period.year_closed, salary_run.approved, salary_run.booked, ...). Pure
 * "created" events leave previous_attributes null.
 */

export function computePreviousAttributes<T extends Record<string, unknown>>(
  prior: T | null | undefined,
  current: T | null | undefined,
): Record<string, unknown> | null {
  if (!prior || !current) return null
  const diff: Record<string, unknown> = {}
  // Iterate over the union of keys so a removed field is also surfaced.
  const keys = new Set([...Object.keys(prior), ...Object.keys(current)])
  for (const k of keys) {
    const a = prior[k]
    const b = current[k]
    if (!shallowEquals(a, b)) {
      diff[k] = a
    }
  }
  return Object.keys(diff).length > 0 ? diff : null
}

function shallowEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  // Cheap structural check via JSON; sufficient for the row-shaped objects
  // we diff. Field order is stable because both sides are projected from
  // the same SELECT.
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
