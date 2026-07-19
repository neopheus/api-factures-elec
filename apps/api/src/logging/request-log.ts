import type { Request } from 'express'

// Corrélation logs (Task 9, phase 5 it.2, spec §6) — lie CHAQUE ligne de log
// HTTP AVAL émise par pino-http (déjà porteuse de req.id, cf.
// logger.module.ts) à l'identité authentifiée de la requête (tenantId ou
// adminId) : sans ce binding, remonter d'une ligne de log HTTP brute à un
// tenant/admin précis exige de croiser manuellement req.id avec un autre log
// applicatif distinct. Posé APRÈS authentification réussie, dans CHACUN des
// 3 guards d'auth (session.guard.ts, api-key.guard.ts, admin.guard.ts) —
// jamais avant : le binding doit refléter l'identité VÉRIFIÉE, pas une
// prétention non authentifiée.
//
// `req.log` n'est PEUPLÉ QUE par le middleware pino-http (nestjs-pino,
// AppLoggerModule) — en tests unitaires (guards instanciés à la main, sans
// app Nest complète démarrée), `req.log` est `undefined`. La garde `?.child`
// ci-dessous absorbe ce cas : un chemin d'authentification ne doit JAMAIS
// throw pour une raison de journalisation.
export function bindRequestLog(
  req: Pick<Request, 'log'>,
  bindings: Record<string, string>,
): void {
  if (req.log?.child) {
    req.log = req.log.child(bindings)
  }
}
