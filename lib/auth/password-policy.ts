import { z } from 'zod'

/** Password rule shared by every server path that sets a password. */
export const passwordSchema = z
  .string()
  .min(8, 'Lösenordet måste vara minst 8 tecken')
  .max(128, 'Lösenordet får vara högst 128 tecken')
  .refine(
    (v) =>
      /[a-z]/.test(v) &&
      /[A-Z]/.test(v) &&
      /[0-9]/.test(v) &&
      /[^a-zA-Z0-9]/.test(v),
    'Lösenordet måste innehålla versaler, gemener, siffror och specialtecken',
  )
