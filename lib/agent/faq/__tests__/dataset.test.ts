import { describe, it, expect } from 'vitest'
import {
  getFaqEntries,
  FAQ_CATEGORY_DISTRIBUTION,
  FAQ_TOTAL_ENTRIES,
} from '../dataset'

// Batch 10 acceptance tests for the seeded FAQ dataset:
//   - exactly 450 entries
//   - exact category distribution
//   - 3-6 question variants per entry
//   - unique ids, no empty answers, no placeholder strings

describe('assistant FAQ dataset', () => {
  const entries = getFaqEntries()

  it('contains exactly 450 entries', () => {
    expect(entries).toHaveLength(FAQ_TOTAL_ENTRIES)
    expect(FAQ_TOTAL_ENTRIES).toBe(450)
  })

  it('matches the exact category distribution', () => {
    const counts = new Map<string, number>()
    for (const e of entries) {
      counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
    }
    // No unexpected categories.
    expect([...counts.keys()].sort()).toEqual(
      Object.keys(FAQ_CATEGORY_DISTRIBUTION).sort(),
    )
    for (const [category, expected] of Object.entries(FAQ_CATEGORY_DISTRIBUTION)) {
      expect(counts.get(category), category).toBe(expected)
    }
    // Distribution sums to the total.
    const sum = Object.values(FAQ_CATEGORY_DISTRIBUTION).reduce((a, b) => a + b, 0)
    expect(sum).toBe(450)
  })

  it('every entry has 3-6 question variants', () => {
    for (const e of entries) {
      expect(e.user_questions.length, e.id).toBeGreaterThanOrEqual(3)
      expect(e.user_questions.length, e.id).toBeLessThanOrEqual(6)
      for (const q of e.user_questions) {
        expect(q.trim().length, e.id).toBeGreaterThan(0)
      }
    }
  })

  it('has no duplicate ids', () => {
    const ids = entries.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has no empty answers', () => {
    for (const e of entries) {
      expect(e.short_answer_sv.trim().length, e.id).toBeGreaterThan(0)
      expect(e.answer_sv.trim().length, e.id).toBeGreaterThan(20)
    }
  })

  it('has no placeholder strings', () => {
    const placeholder = /\b(TODO|FIXME|placeholder|lorem ipsum|TBD)\b/i
    for (const e of entries) {
      const text = JSON.stringify(e)
      expect(placeholder.test(text), `${e.id}: ${text.slice(0, 80)}`).toBe(false)
    }
  })

  it('has no duplicate answers (only-wording-changed clones)', () => {
    const answers = new Map<string, string>()
    for (const e of entries) {
      const existing = answers.get(e.answer_sv)
      expect(existing, `${e.id} duplicates answer of ${existing}`).toBeUndefined()
      answers.set(e.answer_sv, e.id)
    }
  })

  it('every entry has a valid risk level and schema fields', () => {
    for (const e of entries) {
      expect(['low', 'medium', 'high']).toContain(e.risk_level)
      expect(typeof e.intent).toBe('string')
      expect(e.intent.length).toBeGreaterThan(0)
      expect(Array.isArray(e.sources)).toBe(true)
      expect(Array.isArray(e.required_permissions)).toBe(true)
      expect(Array.isArray(e.related_routes)).toBe(true)
      expect(e.escalation === null || typeof e.escalation === 'string').toBe(true)
      expect(e.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  it('high-risk entries carry escalation guidance', () => {
    const high = entries.filter((e) => e.risk_level === 'high')
    expect(high.length).toBeGreaterThan(0)
    for (const e of high) {
      expect(e.escalation, `${e.id} is high risk but lacks escalation`).toBeTruthy()
    }
  })
})
