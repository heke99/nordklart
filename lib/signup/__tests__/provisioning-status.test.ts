import { describe, expect, it } from 'vitest'
import { isRecoverableSignupProvisioningStatus } from '@/lib/signup/provisioning-status'

describe('isRecoverableSignupProvisioningStatus', () => {
  it('keeps an authenticated user in recovery for known setup failures', () => {
    expect(isRecoverableSignupProvisioningStatus(409)).toBe(true)
    expect(isRecoverableSignupProvisioningStatus(422)).toBe(true)
    expect(isRecoverableSignupProvisioningStatus(503)).toBe(true)
  })

  it('does not classify normal or auth responses as setup recovery', () => {
    expect(isRecoverableSignupProvisioningStatus(200)).toBe(false)
    expect(isRecoverableSignupProvisioningStatus(204)).toBe(false)
    expect(isRecoverableSignupProvisioningStatus(401)).toBe(false)
  })
})
