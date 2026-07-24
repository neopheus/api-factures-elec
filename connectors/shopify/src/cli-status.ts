import process from 'node:process'
import { loadConfig } from './config.js'
import { FactelecClient } from './factelec-client.js'
import type { InvoiceLink } from './link-store.js'
import { LinkStore } from './link-store.js'

// CLI `pnpm status` (design §4 : « pas d'UI marchande en v1 ... + CLI
// pnpm status listant les liaisons et leurs statuts Factelec à la
// demande »). Volontairement synchrone à l'appel (pas de polling/watch) :
// un opérateur qui veut un état frais relance la commande — cohérent avec
// « à la demande » du design.

/** Ligne de rapport — une liaison locale + son statut Factelec LIVE si
 * une facture a été soumise (jamais pour `pending_retry`/`abandoned` sans
 * `invoiceId`, il n'y a alors rien à interroger côté Factelec). */
export interface StatusRow {
  link: InvoiceLink
  /** `undefined` si `link.invoiceId` est absent (rien à interroger).
   * `{ ok: true, ... }` sur succès, `{ ok: false, reason }` sur échec (API
   * injoignable/erreur) — jamais levé, motif ConnectionTestResult. */
  remote?:
    | { ok: true; status: string; lifecycleStatus: string }
    | { ok: false; reason: string }
}

/**
 * Interroge l'API Factelec pour chaque liaison ayant un `invoiceId`
 * (« à la demande », design §4) — UNE requête par facture soumise, jamais
 * de polling en arrière-plan. Une erreur sur UNE liaison n'interrompt
 * jamais le rapport global (chaque ligne échoue indépendamment).
 */
export async function buildStatusReport(
  links: InvoiceLink[],
  client: FactelecClient,
): Promise<StatusRow[]> {
  const rows: StatusRow[] = []
  for (const link of links) {
    if (!link.invoiceId) {
      rows.push({ link })
      continue
    }
    try {
      const detail = await client.getInvoiceStatus(link.invoiceId)
      rows.push({
        link,
        remote: {
          ok: true,
          status: typeof detail.status === 'string' ? detail.status : 'inconnu',
          lifecycleStatus:
            typeof detail.lifecycleStatus === 'string'
              ? detail.lifecycleStatus
              : 'inconnu',
        },
      })
    } catch (error) {
      // `error.message` uniquement — motif FactelecApiError (jamais la clé API).
      const reason = error instanceof Error ? error.message : String(error)
      rows.push({ link, remote: { ok: false, reason } })
    }
  }
  return rows
}

/** Rendu texte tabulé (pas de dépendance table CLI — motif zéro-dépendance
 * connecteurs, design §2) : une ligne par liaison, colonnes alignées par
 * tabulation (lisible en terminal ET redirigeable vers un fichier/pipe). */
export function formatStatusReport(rows: StatusRow[]): string {
  if (rows.length === 0) return 'Aucune liaison commande/facture enregistrée.'

  const header = [
    'order_id',
    'statut',
    'invoice_id',
    'tentatives',
    'maj',
    'statut_factelec',
  ].join('\t')

  const lines = rows.map(({ link, remote }) => {
    const factelec = formatRemoteStatus(remote)
    return [
      link.orderId,
      link.status,
      link.invoiceId ?? '-',
      String(link.attempts),
      link.updatedAt,
      factelec,
    ].join('\t')
  })

  return [header, ...lines].join('\n')
}

function formatRemoteStatus(remote: StatusRow['remote']): string {
  if (!remote) return '-'
  if (!remote.ok) return `injoignable (${remote.reason})`
  return `${remote.status}/${remote.lifecycleStatus}`
}

async function main(): Promise<void> {
  const config = loadConfig()
  const store = new LinkStore(config.linkDbPath)
  const client = new FactelecClient(
    config.factelec.apiUrl,
    config.factelec.apiKey,
  )

  try {
    const rows = await buildStatusReport(store.listAll(), client)
    console.log(formatStatusReport(rows))
  } finally {
    store.close()
  }
}

// Garde d'entrée — `buildStatusReport`/`formatStatusReport` sont importées
// par les tests (tests/cli-status.test.ts) : sans cette garde, `main()`
// s'exécuterait (et échouerait, `process.env` incomplet en test) au seul
// import du module. Motif standard ESM Node : ne lance `main()` QUE quand
// ce fichier est le point d'entrée du process, jamais quand il est importé.
const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  main().catch((error) => {
    console.error('[shopify-connector] pnpm status a échoué', error)
    process.exitCode = 1
  })
}
