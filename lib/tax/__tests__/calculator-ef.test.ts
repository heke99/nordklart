import { describe, it, expect } from 'vitest'
import { calculateEFTax } from '../calculator'

describe('calculateEFTax', () => {
  it('charges egenavgifter on the surplus after the 25 % schablonavdrag', () => {
    const result = calculateEFTax(400_000)
    // 400 000 − 25 % = 300 000; 28,97 % of 300 000 = 86 910
    expect(result.egenavgifter).toBe(86_910)
  })

  it('applies statlig skatt only above the 2026 skiktgräns of 643 000 kr', () => {
    // 900 000 surplus → 675 000 after schablonavdrag; grundavdrag 17 400 at
    // this level → 657 600 beskattningsbar; 14 600 above 643 000 × 20 %.
    const result = calculateEFTax(900_000)
    expect(result.state_tax).toBe(2_920)
  })
})
