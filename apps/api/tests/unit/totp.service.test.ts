import { generate as generateOtp } from 'otplib'
import { describe, expect, it } from 'vitest'
import { TotpService } from '../../src/admin/totp.service.js'

describe('TotpService', () => {
  describe('generateSecret / otpauthUrl', () => {
    it('generates a base32 secret', () => {
      const service = new TotpService()
      const secret = service.generateSecret()
      expect(secret).toMatch(/^[A-Z2-7]+$/) // base32 (RFC 4648 §6, alphabet sans padding)
      expect(secret.length).toBeGreaterThanOrEqual(16)
    })

    it('builds an otpauth:// URI with issuer Factelec and the admin email as label', () => {
      const service = new TotpService()
      const secret = service.generateSecret()
      const uri = service.otpauthUrl('root@factelec.fr', secret)
      expect(uri).toMatch(/^otpauth:\/\/totp\//)
      expect(uri).toContain('Factelec')
      expect(uri).toContain(encodeURIComponent('root@factelec.fr'))
      expect(uri).toContain(`secret=${secret}`)
    })
  })

  describe('verify (fenêtre ±1 pas de 30s)', () => {
    it('accepts the code generated for the current time step', async () => {
      const service = new TotpService()
      const secret = service.generateSecret()
      const now = Math.floor(Date.now() / 1000)
      const code = await generateOtp({ secret, epoch: now })
      expect(await service.verify(secret, code)).toBe(true)
    })

    it('accepts a code generated exactly one step (30s) in the past', async () => {
      const service = new TotpService()
      const secret = service.generateSecret()
      const now = Math.floor(Date.now() / 1000)
      const code = await generateOtp({ secret, epoch: now - 30 })
      expect(await service.verify(secret, code)).toBe(true)
    })

    it('accepts a code generated exactly one step (30s) in the future', async () => {
      const service = new TotpService()
      const secret = service.generateSecret()
      const now = Math.floor(Date.now() / 1000)
      const code = await generateOtp({ secret, epoch: now + 30 })
      expect(await service.verify(secret, code)).toBe(true)
    })

    it('rejects a code generated 2 steps (60s) away — outside the ±1 window', async () => {
      const service = new TotpService()
      const secret = service.generateSecret()
      const now = Math.floor(Date.now() / 1000)
      const codePast = await generateOtp({ secret, epoch: now - 60 })
      const codeFuture = await generateOtp({ secret, epoch: now + 60 })
      expect(await service.verify(secret, codePast)).toBe(false)
      expect(await service.verify(secret, codeFuture)).toBe(false)
    })

    it('rejects a wrong code entirely', async () => {
      const service = new TotpService()
      const secret = service.generateSecret()
      const now = Math.floor(Date.now() / 1000)
      const code = await generateOtp({ secret, epoch: now })
      const wrongLastDigit = ((Number(code.at(-1)) + 1) % 10).toString()
      const wrong = code.slice(0, -1) + wrongLastDigit
      expect(await service.verify(secret, wrong)).toBe(false)
    })

    it('never mutates a shared/global otplib config across calls (2 independent secrets, both verify correctly)', async () => {
      const service = new TotpService()
      const secretA = service.generateSecret()
      const secretB = service.generateSecret()
      const now = Math.floor(Date.now() / 1000)
      const codeA = await generateOtp({ secret: secretA, epoch: now })
      const codeB = await generateOtp({ secret: secretB, epoch: now })
      expect(await service.verify(secretA, codeA)).toBe(true)
      expect(await service.verify(secretB, codeB)).toBe(true)
      // Un code de A ne doit jamais valider contre B (secrets indépendants).
      expect(await service.verify(secretB, codeA)).toBe(false)
    })
  })

  describe('generateRecoveryCodes', () => {
    it('generates 10 codes, format xxxx-xxxx, all distinct, hashed argon2id', async () => {
      const service = new TotpService()
      const { plain, hashed } = await service.generateRecoveryCodes()

      expect(plain).toHaveLength(10)
      expect(hashed).toHaveLength(10)
      for (const code of plain) {
        expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/)
      }
      expect(new Set(plain).size).toBe(10) // tous distincts
      for (const hash of hashed) {
        expect(hash).toMatch(/^\$argon2id\$/)
      }
    })
  })

  describe('consumeRecoveryCode', () => {
    it('consumes a valid code once — a second attempt with the same code fails', async () => {
      const service = new TotpService()
      const { plain, hashed } = await service.generateRecoveryCodes()
      const target = plain[3]!

      const first = await service.consumeRecoveryCode(hashed, target)
      expect(first.ok).toBe(true)
      expect(first.remaining).toHaveLength(9)

      const second = await service.consumeRecoveryCode(first.remaining, target)
      expect(second.ok).toBe(false)
      expect(second.remaining).toHaveLength(9) // inchangé
    })

    it('leaves the other 9 codes usable after one is consumed', async () => {
      const service = new TotpService()
      const { plain, hashed } = await service.generateRecoveryCodes()
      const { remaining } = await service.consumeRecoveryCode(hashed, plain[0]!)

      const other = await service.consumeRecoveryCode(remaining, plain[5]!)
      expect(other.ok).toBe(true)
      expect(other.remaining).toHaveLength(8)
    })

    it('rejects an unknown code without mutating the input array', async () => {
      const service = new TotpService()
      const { hashed } = await service.generateRecoveryCodes()
      const result = await service.consumeRecoveryCode(hashed, 'ffff-ffff')
      expect(result.ok).toBe(false)
      expect(result.remaining).toEqual(hashed)
    })
  })
})
