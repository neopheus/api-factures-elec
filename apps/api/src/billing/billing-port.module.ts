import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { EnvConfig } from '../config/env.js'
import { BILLING_PORT, type BillingPort } from './billing.port.js'
import { FakeBillingDriver } from './fake-billing.driver.js'
import { NoneBillingDriver } from './none-billing.driver.js'
import { StripeBillingDriver } from './stripe-billing.driver.js'

// Sélection du driver billing par env — motif ConsentSignatureModule (3.5).
// 'stripe' exige les 4 clés STRIPE_* : throw au bootstrap (fail-fast) plutôt
// qu'au premier appel.
@Global()
@Module({
  providers: [
    {
      provide: BILLING_PORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>): BillingPort => {
        const driver = config.get('BILLING_DRIVER', { infer: true })
        if (driver === 'none') return new NoneBillingDriver()
        if (driver === 'fake') return new FakeBillingDriver()
        if (driver === 'stripe') {
          const secretKey = config.get('STRIPE_SECRET_KEY', { infer: true })
          const webhookSecret = config.get('STRIPE_WEBHOOK_SECRET', {
            infer: true,
          })
          const priceBase = config.get('STRIPE_PRICE_BASE', { infer: true })
          const priceMetered = config.get('STRIPE_PRICE_METERED', {
            infer: true,
          })
          if (!secretKey || !webhookSecret || !priceBase || !priceMetered)
            throw new Error(
              'BILLING_DRIVER=stripe exige STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_BASE et STRIPE_PRICE_METERED',
            )
          return new StripeBillingDriver(
            secretKey,
            webhookSecret,
            priceBase,
            priceMetered,
          )
        }
        // exhaustivité : zod borne déjà l'énum, ceci est le filet anti-drift
        throw new Error(`driver billing inconnu: ${driver satisfies never}`)
      },
    },
  ],
  exports: [BILLING_PORT],
})
export class BillingPortModule {}
