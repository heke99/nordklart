import type { Extension } from '@/lib/extensions/types'
import { registerEmailService } from '@/lib/email/service'
import { ResendEmailService } from './lib/resend-service'

// Register the Resend implementation immediately when this extension is loaded
registerEmailService(new ResendEmailService())

export const emailExtension: Extension = {
  id: 'email',
  name: 'E-post (Resend)',
  version: '1.0.0',
}
