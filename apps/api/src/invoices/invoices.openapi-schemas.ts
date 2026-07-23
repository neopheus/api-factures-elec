// Fragments JSON Schema pour la documentation OpenAPI (@ApiBody/@ApiResponse)
// du périmètre public — PUREMENT DÉCLARATIFS, ne participent à AUCUNE
// validation runtime (celle-ci reste zod, cf. @factelec/invoice-core
// `invoiceInputSchema` — source de vérité des champs listés ici). Pas de
// classe DTO ici par choix (mandat Task 1, phase 4 it.1) : ces objets
// littéraux évitent de dupliquer/refactorer les schémas zod existants.
import { routingStatus as routingStatusEnum } from '../db/schema.js'
import { KINDS as FORMAT_KINDS } from './format-kind.js'
import { LIFECYCLE_STATUSES } from './lifecycle-status.js'

export const postalAddressBodySchema = {
  type: 'object',
  properties: {
    streetName: { type: 'string', description: 'Voie (BT-35/BT-50)' },
    city: { type: 'string', description: 'Ville (BT-37/BT-52)' },
    postalCode: { type: 'string', description: 'Code postal (BT-38/BT-53)' },
    countryCode: {
      type: 'string',
      example: 'FR',
      description: 'Code pays ISO 3166-1 alpha-2 (BT-40/BT-55)',
    },
  },
  required: ['countryCode'],
}

export const partyBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Raison sociale (BT-27/BT-44)' },
    siren: {
      type: 'string',
      description: 'SIREN (9 chiffres) ou SIRET (14) — optionnel (BT-30/BT-47)',
    },
    vatId: {
      type: 'string',
      description: 'Numéro de TVA intracommunautaire — optionnel (BT-31/BT-48)',
    },
    address: postalAddressBodySchema,
  },
  required: ['name', 'address'],
}

export const invoiceLineBodySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Identifiant de ligne (BT-126)' },
    name: { type: 'string', description: 'Désignation (BT-153)' },
    quantity: {
      type: 'string',
      example: '1.0000',
      description: "Quantité, décimal jusqu'à 4 décimales (BT-129)",
    },
    unitCode: {
      type: 'string',
      example: 'C62',
      description: 'Code unité UN/ECE recommandation 20 (BT-130)',
    },
    unitPrice: {
      type: 'string',
      example: '10.0000',
      description: "Prix unitaire, décimal jusqu'à 4 décimales (BT-146)",
    },
    vatCategory: {
      type: 'string',
      enum: ['S', 'Z', 'E', 'AE', 'K', 'G', 'O', 'L', 'M'],
      description: 'Catégorie de TVA EN 16931 (BT-151)',
    },
    vatRate: {
      type: 'string',
      example: '20.00',
      description: 'Taux de TVA en pourcentage (BT-152)',
    },
    exemptionReasonCode: {
      type: 'string',
      description:
        "Code motif d'exonération VATEX — requis pour les catégories exonérées (BT-121)",
    },
    exemptionReason: {
      type: 'string',
      description: "Motif d'exonération en texte libre (BT-120)",
    },
    nature: {
      type: 'string',
      enum: ['goods', 'services'],
      description: 'Nature de la ligne (biens/services), optionnel',
    },
  },
  required: [
    'id',
    'name',
    'quantity',
    'unitCode',
    'unitPrice',
    'vatCategory',
    'vatRate',
  ],
}

// Body de `POST /invoices` — miroir sobre de `invoiceInputSchema`
// (packages/invoice-core/src/model/schema.ts), sans les champs calculés
// (lignes/totaux/ventilation TVA, ajoutés par `buildInvoice` côté serveur).
export const invoiceIngestBodySchema = {
  type: 'object',
  properties: {
    number: { type: 'string', description: 'Numéro de facture (BT-1)' },
    issueDate: {
      type: 'string',
      format: 'date',
      description: "Date d'émission AAAA-MM-JJ (BT-2)",
    },
    dueDate: {
      type: 'string',
      format: 'date',
      description: "Date d'échéance AAAA-MM-JJ, optionnelle (BT-9)",
    },
    typeCode: {
      type: 'string',
      enum: ['380', '381'],
      description: 'Facture (380) ou avoir (381) — BT-3',
    },
    currency: {
      type: 'string',
      example: 'EUR',
      description: 'Code devise ISO 4217 (BT-5)',
    },
    businessProcessType: {
      type: 'string',
      description: 'Cadre de facturation DGFiP, optionnel (BT-23, règle G1.02)',
    },
    seller: partyBodySchema,
    buyer: partyBodySchema,
    lines: {
      type: 'array',
      items: invoiceLineBodySchema,
      minItems: 1,
      description: 'Lignes de facture (BG-25), au moins une',
    },
  },
  required: [
    'number',
    'issueDate',
    'typeCode',
    'currency',
    'seller',
    'buyer',
    'lines',
  ],
}

// Corps d'erreur uniforme (ProblemDetailsFilter, RFC 9457).
export const problemDetailsSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'number' },
    detail: { type: 'string' },
    errors: {},
  },
  required: ['type', 'title', 'status'],
}

// Résumé de facture — miroir sobre d'`InvoiceSummary`/`InvoiceDetail`
// (invoices.repository.ts, les deux types sont identiques, cf. commentaire
// source). Réutilisé par `GET /invoices` (liste) et `GET /invoices/:id`
// (détail, avec `availableFormats` en plus).
export const invoiceSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    number: { type: 'string' },
    typeCode: { type: 'string', enum: ['380', '381'] },
    issueDate: { type: 'string', format: 'date' },
    currency: { type: 'string' },
    status: {
      type: 'string',
      enum: ['received', 'generating', 'generated', 'failed'],
      description:
        'Statut de génération des formats (interne, distinct du statut CDV)',
    },
    lifecycleStatus: {
      type: 'string',
      enum: LIFECYCLE_STATUSES,
      description: 'Statut CDV courant (nomenclature DGFiP 200-213)',
    },
    createdAt: { type: 'string', format: 'date-time' },
    routingStatus: {
      type: 'string',
      enum: routingStatusEnum.enumValues,
      description: 'Statut de résolution du destinataire (annuaire)',
    },
    recipientPlatform: { type: 'string', nullable: true },
  },
  required: [
    'id',
    'number',
    'typeCode',
    'issueDate',
    'currency',
    'status',
    'lifecycleStatus',
    'createdAt',
    'routingStatus',
    'recipientPlatform',
  ],
}

export const invoiceDetailSchema = {
  type: 'object',
  properties: {
    ...invoiceSummarySchema.properties,
    availableFormats: {
      type: 'array',
      items: { type: 'string', enum: [...FORMAT_KINDS] },
      description:
        'Formats déjà générés et téléchargeables via GET /invoices/:id/formats/:format',
    },
  },
  required: [...invoiceSummarySchema.required, 'availableFormats'],
}

export const invoiceListResponseSchema = {
  type: 'object',
  properties: {
    items: { type: 'array', items: invoiceSummarySchema },
    nextCursor: {
      type: 'string',
      nullable: true,
      description:
        'Curseur opaque à repasser en `?cursor=` pour la page suivante, `null` si dernière page',
    },
  },
  required: ['items', 'nextCursor'],
}

// Réponse de `GET /invoices/:id/status` (historique CDV, LifecycleService#history).
export const lifecycleHistoryResponseSchema = {
  type: 'object',
  properties: {
    current: { type: 'string', enum: LIFECYCLE_STATUSES },
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fromStatus: {
            type: 'string',
            enum: LIFECYCLE_STATUSES,
            nullable: true,
          },
          toStatus: { type: 'string', enum: LIFECYCLE_STATUSES },
          actor: {
            type: 'string',
            description: 'ex. `user:<uuid>`, `platform`',
          },
          reason: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['fromStatus', 'toStatus', 'actor', 'reason', 'createdAt'],
      },
    },
  },
  required: ['current', 'events'],
}
