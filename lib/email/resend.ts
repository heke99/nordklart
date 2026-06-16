/**
 * @deprecated Import from '@/lib/email/service' instead.
 * This file exists only for backward compatibility.
 */

import { getEmailService } from './service'
import type { SendEmailOptions, SendEmailResult } from './service'

export type { SendEmailOptions, SendEmailResult }

export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  return getEmailService().sendEmail(options)
}

export function isResendConfigured(): boolean {
  return getEmailService().isConfigured()
}
