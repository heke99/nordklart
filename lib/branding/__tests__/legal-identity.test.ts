import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NORDKLART_LEGAL_DISCLOSURE,
  NORDKLART_LEGAL_NAME,
  NORDKLART_ORG_NUMBER,
  NORDKLART_PRODUCT_NAME,
  NORDKLART_VAT_NUMBER,
} from '../legal-identity'

describe('Nordklart hosted legal identity', () => {
  it('keeps product and legal entity separate', () => {
    expect(NORDKLART_PRODUCT_NAME).toBe('Nordklart')
    expect(NORDKLART_LEGAL_NAME).toBe('Trafexa Nordic AB')
    expect(NORDKLART_LEGAL_NAME).not.toBe(`${NORDKLART_PRODUCT_NAME} AB`)
  })

  it('exposes the canonical Swedish organisation and VAT numbers', () => {
    expect(NORDKLART_ORG_NUMBER).toBe('556855-4884')
    expect(NORDKLART_VAT_NUMBER).toBe('SE556855488401')
  })

  it('states that Nordklart is not a separate company', () => {
    expect(NORDKLART_LEGAL_DISCLOSURE).toContain('inte ett separat aktiebolag')
    expect(NORDKLART_LEGAL_DISCLOSURE).toContain(NORDKLART_LEGAL_NAME)
  })

  it('no source file carries the previous supplier identity', () => {
    // The supplier changed to Trafexa Nordic AB. Applied migrations are
    // immutable history and are the only place the old identity may remain.
    const roots = ['app', 'components', 'lib', 'extensions', 'scripts', '.claude']
    // Guard tests that assert the old identity is absent must name it.
    const guards = new Set([
      path.join('lib', 'branding', '__tests__', 'legal-identity.test.ts'),
      path.join('lib', 'skatteverket', 'sysorg', '__tests__', 'config.test.ts'),
    ])
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '_generated') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(tsx?|mjs|md|json)$/.test(entry.name) && !guards.has(full)) {
          const text = fs.readFileSync(full, 'utf8')
          if (/gridex/i.test(text) || /559416-?7149/.test(text)) offenders.push(full)
        }
      }
    }
    for (const root of roots) if (fs.existsSync(root)) walk(root)
    expect(offenders).toEqual([])
  })
})
