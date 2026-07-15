import { Inject, Injectable } from '@nestjs/common'
import type pg from 'pg'
import { APP_POOL } from '../db/client.js'

// Dette 1.4 (Task 7) : sessions est deny-all pour factelec_app (RLS FORCE
// sans policy, cf. migration 0003) — seule la fonction SECURITY DEFINER
// `purge_expired_sessions` (0009) peut y toucher. Analogue à
// InvoiceReconciliationService pour la réconciliation des factures.
@Injectable()
export class SessionMaintenanceService {
  constructor(@Inject(APP_POOL) private readonly pool: pg.Pool) {}

  // Appelle la fonction SECURITY DEFINER (sessions = deny-all pour app).
  async purgeExpiredSessions(): Promise<number> {
    const r = await this.pool.query<{ n: number }>(
      'SELECT purge_expired_sessions() AS n',
    )
    return r.rows[0]?.n ?? 0
  }
}
