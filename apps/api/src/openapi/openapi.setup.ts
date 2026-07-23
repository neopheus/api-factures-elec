import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { INestApplication } from '@nestjs/common'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { HealthModule } from '../health/health.module.js'
import { InvoicesModule } from '../invoices/invoices.module.js'

// Résolu relativement à CE fichier (motif health.controller.ts#JOURNAL_PATH) :
// `src/openapi/` et `dist/openapi/` (swc --out-dir dist --strip-leading-paths)
// sont à la même profondeur sous la racine du package — le même nombre de
// remontées `..` résout donc `package.json` en dev (tsx), en test (vitest+swc)
// ET en prod (dist/).
const PACKAGE_JSON_PATH = resolve(import.meta.dirname, '../../package.json')

function readApiVersion(): string {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
    version: string
  }
  return pkg.version
}

// Périmètre PUBLIC clé-API de la phase 4 it.1 (spec §2, task-1-brief.md) —
// SEULS les modules listés ici sont scannés par SwaggerModule (`include`,
// PAS de deep-scan des imports transitifs de ces modules) : jamais AppModule
// entier, jamais une fuite de /admin, /auth, /billing, /metrics ou d'une
// route session-only. Décision de périmètre (guard par guard, cf. rapport
// task-1) :
//   - HealthModule : sonde publique, sans authentification.
//   - InvoicesModule : dépôt (POST /invoices, ApiKeyGuard), lecture
//     (GET /invoices, GET /invoices/:id, GET /invoices/:id/formats/:format,
//     GET /invoices/:id/status — TenantAuthGuard, clé API OU session), tous
//     compatibles clé API. Deux routes de CE MÊME contrôleur sont exclues du
//     document malgré l'`include` (@ApiExcludeEndpoint posé directement sur
//     chacune, cf. invoices.controller.ts) :
//       - POST /invoices/:id/status (SessionGuard SEUL — jamais accessible
//         par clé API, donc hors périmètre public par construction) ;
//       - POST /invoices/:id/routing/resolve (TenantAuthGuard dual-auth,
//         DONC techniquement joignable par clé API, mais action opérateur de
//         résolution d'un routage ambigu — hors du périmètre connecteur
//         PrestaShop it.1 documenté par la spec §2/§3, non listée par le
//         brief Task 1 : dépôt/lecture/formats/statut CDV/santé).
const PUBLIC_MODULES = [HealthModule, InvoicesModule]

export function buildPublicOpenApiDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Factelec API publique')
    .setDescription(
      'API publique Factelec — périmètre clé API (intégrateurs tiers, ex. connecteur PrestaShop) : dépôt et consultation de factures, téléchargement des formats générés, suivi du statut CDV (cycle de vie DGFiP). Authentification : en-tête `Authorization: Bearer <clé API>`.',
    )
    .setVersion(readApiVersion())
    .setOpenAPIVersion('3.1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description:
          'Clé API tenant, portée dans `Authorization: Bearer <clé>`.',
      },
      'ApiKey',
    )
    .build()

  return SwaggerModule.createDocument(app, config, {
    include: PUBLIC_MODULES,
  })
}

// JSON seul (pas d'UI Swagger — mandat brief Task 1) : `ui: false` désactive
// le montage de la UI (aucune route HTML/asset statique posée), `raw: ['json']`
// restreint la sérialisation à `jsonDocumentUrl` (yaml exclu, non demandé).
export function setupPublicOpenApi(app: INestApplication): void {
  const document = buildPublicOpenApiDocument(app)
  SwaggerModule.setup('openapi', app, document, {
    ui: false,
    raw: ['json'],
    jsonDocumentUrl: 'openapi.json',
  })
}
