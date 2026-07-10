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
    expect(NORDKLART_LEGAL_NAME).toBe('Gridex El AB')
    expect(NORDKLART_LEGAL_NAME).not.toBe(`${NORDKLART_PRODUCT_NAME} AB`)
  })

  it('exposes the canonical Swedish organisation and VAT numbers', () => {
    expect(NORDKLART_ORG_NUMBER).toBe('559416-7149')
    expect(NORDKLART_VAT_NUMBER).toBe('SE559416714901')
  })

  it('states that Nordklart is not a separate company', () => {
    expect(NORDKLART_LEGAL_DISCLOSURE).toContain('inte ett separat aktiebolag')
    expect(NORDKLART_LEGAL_DISCLOSURE).toContain(NORDKLART_LEGAL_NAME)
  })
})
