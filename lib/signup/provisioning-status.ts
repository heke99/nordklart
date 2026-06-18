export type SignupProvisioningApiState = 'not_required' | 'in_progress' | 'failed' | 'provisioned'

export function isRecoverableSignupProvisioningStatus(status: number): boolean {
  return status === 409 || status === 422 || status === 503
}
