// Options nommées pour les décorateurs @nestjs/swagger du périmètre public
// (Task 1, phase 4 it.1). Déclarées ICI (hors du contrôleur) à dessein : tout
// décorateur `@Api*(...)` dans invoices.controller.ts référence un
// IDENTIFIANT unique sur une seule ligne (jamais un littéral multi-lignes) —
// `tests/unit/dual-auth-composition.arch.test.ts` scanne le bloc de
// décorateurs contigu au-dessus de chaque méthode ligne par ligne (toute
// ligne qui ne commence pas par `@` ferme le bloc, y compris une ligne de
// continuation d'un objet multi-lignes) ; un `@ApiOperation({ ... })` étalé
// sur plusieurs lignes casserait la détection de `@UseGuards(...)` sur les
// routes dual-auth existantes (`resolveRouting`, seule route de ce fichier
// dans la liste "7 routes conformes" du verrou). Garder chaque décorateur
// sur une ligne, quelle que soit la verbosité de son contenu, élimine ce
// risque par construction.
import type {
  ApiBodyOptions,
  ApiOperationOptions,
  ApiParamOptions,
  ApiQueryOptions,
  ApiResponseOptions,
} from '@nestjs/swagger'
import { routingStatus as routingStatusEnum } from '../db/schema.js'
import { KINDS as FORMAT_KINDS } from './format-kind.js'
import {
  invoiceDetailSchema,
  invoiceIngestBodySchema,
  invoiceListResponseSchema,
  lifecycleHistoryResponseSchema,
  problemDetailsSchema,
} from './invoices.openapi-schemas.js'

// --- Paramètres de chemin partagés ---

export const ID_PARAM: ApiParamOptions = {
  name: 'id',
  description: 'Identifiant (UUID) de la facture.',
}

export const FORMAT_PARAM: ApiParamOptions = {
  name: 'format',
  enum: FORMAT_KINDS,
  description: 'Format de représentation généré pour la facture.',
}

// --- Réponses d'erreur partagées (RFC 9457, ProblemDetailsFilter) ---

export const UNAUTHORIZED_RESPONSE: ApiResponseOptions = {
  status: 401,
  description: 'Clé API manquante ou invalide (ou session absente/expirée).',
  schema: problemDetailsSchema,
}

export const INVOICE_NOT_FOUND_RESPONSE: ApiResponseOptions = {
  status: 404,
  description:
    'Facture inconnue pour ce tenant (ou identifiant hors format UUID).',
  schema: problemDetailsSchema,
}

// --- POST /invoices ---

export const INGEST_OPERATION: ApiOperationOptions = {
  summary: 'Déposer une facture',
  description:
    "Dépôt d'une facture au format canonique EN 16931 (JSON). Validation structurelle puis règles métier ; persistance immédiate au statut CDV `deposee` (code DGFiP 200) et enfilement asynchrone de la génération des formats (UBL, CII, Factur-X, Flux DGFiP).",
}

export const INGEST_BODY_OPTIONS: ApiBodyOptions = {
  description: 'Facture canonique EN 16931.',
  schema: invoiceIngestBodySchema,
}

export const INGEST_CREATED_RESPONSE: ApiResponseOptions = {
  status: 201,
  description: 'Facture reçue, statut CDV initial `deposee`.',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      status: { type: 'string', example: 'received' },
    },
    required: ['id', 'status'],
  },
}

export const INGEST_VALIDATION_RESPONSE: ApiResponseOptions = {
  status: 422,
  description:
    'Facture structurellement invalide ou violant une règle métier EN 16931.',
  schema: problemDetailsSchema,
}

export const INGEST_CONFLICT_RESPONSE: ApiResponseOptions = {
  status: 409,
  description: 'Une facture avec ce numéro existe déjà pour ce tenant.',
  schema: problemDetailsSchema,
}

export const INGEST_PAYMENT_REQUIRED_RESPONSE: ApiResponseOptions = {
  status: 402,
  description:
    "Abonnement du tenant invalide (si l'enforcement de facturation est actif).",
  schema: problemDetailsSchema,
}

export const INGEST_SUSPENDED_RESPONSE: ApiResponseOptions = {
  status: 403,
  description: 'Tenant suspendu par un opérateur de la plateforme.',
  schema: problemDetailsSchema,
}

// --- GET /invoices ---

export const LIST_OPERATION: ApiOperationOptions = {
  summary: 'Lister les factures du tenant',
  description:
    'Pagination par curseur opaque (keyset), tri par date de création décroissante.',
}

export const LIST_LIMIT_QUERY: ApiQueryOptions = {
  name: 'limit',
  required: false,
  description: 'Nombre maximum de résultats (1 à 100, défaut 20).',
  schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
}

export const LIST_CURSOR_QUERY: ApiQueryOptions = {
  name: 'cursor',
  required: false,
  description: 'Curseur opaque retourné par la page précédente (`nextCursor`).',
  schema: { type: 'string' },
}

export const LIST_ROUTING_STATUS_QUERY: ApiQueryOptions = {
  name: 'routingStatus',
  required: false,
  description: 'Filtre sur le statut de résolution du destinataire (annuaire).',
  schema: { type: 'string', enum: routingStatusEnum.enumValues },
}

export const LIST_RESPONSE: ApiResponseOptions = {
  status: 200,
  description: 'Page de factures.',
  schema: invoiceListResponseSchema,
}

// --- GET /invoices/:id ---

export const GET_OPERATION: ApiOperationOptions = {
  summary: 'Consulter une facture',
  description:
    'Détail complet, y compris les formats déjà générés et téléchargeables.',
}

export const GET_RESPONSE: ApiResponseOptions = {
  status: 200,
  description: 'Détail de la facture.',
  schema: invoiceDetailSchema,
}

// --- GET /invoices/:id/formats/:format ---

export const GET_FORMAT_OPERATION: ApiOperationOptions = {
  summary: 'Télécharger un format généré',
  description:
    "Contenu brut du format demandé (Content-Type variable selon `format` : `application/xml` pour ubl/cii/flux_base/flux_full, propre au format Factur-X pour `facturx`). 404 si la facture ou ce format précis n'existe pas encore (génération asynchrone après dépôt).",
}

export const GET_FORMAT_RESPONSE: ApiResponseOptions = {
  status: 200,
  description: 'Contenu du format généré.',
}

// --- GET /invoices/:id/status ---

export const GET_STATUS_OPERATION: ApiOperationOptions = {
  summary: 'Consulter le statut CDV et son historique',
  description:
    'Statut CDV courant (nomenclature DGFiP 200-213, cf. XP Z12-012/XP Z12-014) et historique complet des transitions de cette facture.',
}

export const GET_STATUS_RESPONSE: ApiResponseOptions = {
  status: 200,
  description: 'Statut courant et historique des transitions.',
  schema: lifecycleHistoryResponseSchema,
}
