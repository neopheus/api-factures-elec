import { z } from 'zod'

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
})

export const signupSchema = z.object({
  email: z.email(),
  password: z.string().min(12, 'Au moins 12 caractères'),
  organizationName: z.string().min(1, 'Nom requis'),
  siren: z
    .string()
    .regex(/^\d{9}$/, 'SIREN à 9 chiffres')
    .or(z.literal(''))
    .transform((v) => (v === '' ? null : v)),
})

export const createKeySchema = z.object({ label: z.string().min(1).max(100) })
