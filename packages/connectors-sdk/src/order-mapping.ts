// Contrat de mapping commande→facture, VU DU CONNECTEUR (ex. module
// PrestaShop, phase 4 it.1). Ce fichier est un MIROIR STRUCTUREL de
// `invoiceInputSchema` (`@factelec/invoice-core`,
// packages/invoice-core/src/model/schema.ts) — PAS un import direct de ce
// paquet : `@factelec/connectors-sdk` est le contrat public distribué aux
// intégrateurs tiers indépendamment de l'implémentation interne (invoice-core
// embarque des dépendances lourdes — @cantoo/pdf-lib, xmlbuilder2,
// saxon-js/xslt3 pour la génération XSLT — hors sujet pour un connecteur qui
// ne fait QUE mapper une commande puis POSTer sur `/invoices`).
//
// Toute divergence entre ce fichier (et `schema/order-mapping.schema.json`,
// sa contrepartie JSON Schema) et le zod réel de invoice-core est un bug DE
// CE PAQUET — vérifié de deux façons :
//   1. `tests/order-mapping-schema.test.ts` (CE paquet) : les fixtures de
//      `fixtures/*.json` valident contre `schema/order-mapping.schema.json`.
//   2. `apps/api/tests/e2e/connectors-fixtures.e2e.test.ts` : ces MÊMES
//      fixtures sont POSTées contre l'API réelle (`POST /invoices`) → 201,
//      preuve que le contrat documenté ici correspond au zod réel exécuté
//      côté serveur, pas seulement à sa lecture.
//
// Champs calculés par le serveur (lignes enrichies, ventilation TVA, totaux
// — cf. `buildInvoice` dans invoice-core) sont volontairement ABSENTS d'ici :
// ce contrat ne décrit que ce que le connecteur envoie, jamais ce que
// l'API calcule et renvoie.

/** BT-151/BT-118 — catégorie de TVA EN 16931. */
export const VAT_CATEGORIES = [
  'S',
  'Z',
  'E',
  'AE',
  'K',
  'G',
  'O',
  'L',
  'M',
] as const
export type VatCategory = (typeof VAT_CATEGORIES)[number]

/** BT-3 — type de document : 380 (facture) ou 381 (avoir). */
export const INVOICE_TYPE_CODES = ['380', '381'] as const
export type InvoiceTypeCode = (typeof INVOICE_TYPE_CODES)[number]

/**
 * BT-23 — cadre de facturation DGFiP (règle de gestion G1.02, nomenclature
 * fermée de 13 codes). Optionnel côté payload — laissez le champ absent si le
 * connecteur ne connaît pas le cadre applicable.
 */
export const BUSINESS_PROCESS_TYPES = [
  'B1',
  'S1',
  'M1',
  'B2',
  'S2',
  'M2',
  'B4',
  'S4',
  'M4',
  'S5',
  'S6',
  'B7',
  'S7',
] as const
export type BusinessProcessType = (typeof BUSINESS_PROCESS_TYPES)[number]

/** Discriminant biens/services de ligne (extension interne Factelec, hors EN 16931). */
export const INVOICE_LINE_NATURES = ['goods', 'services'] as const
export type InvoiceLineNature = (typeof INVOICE_LINE_NATURES)[number]

/** BG-5/BG-8 — adresse postale (vendeur ou acheteur). */
export interface PostalAddress {
  /** BT-35/BT-50 */
  streetName?: string
  /** BT-37/BT-52 */
  city?: string
  /** BT-38/BT-53 */
  postalCode?: string
  /** BT-40/BT-55 — ISO 3166-1 alpha-2, ex. "FR". */
  countryCode: string
}

/** BG-4 (vendeur) / BG-7 (acheteur). */
export interface Party {
  /** BT-27/BT-44 — raison sociale ou nom du client. */
  name: string
  /**
   * BT-30/BT-47 — SIREN (9 chiffres) ou SIRET (14 chiffres), optionnel.
   * Absent pour un particulier (B2C) : Factelec route alors la facture en
   * e-reporting plutôt qu'en facturation B2B.
   */
  siren?: string
  /** BT-31/BT-48 — numéro de TVA intracommunautaire, optionnel. */
  vatId?: string
  address: PostalAddress
}

/** BG-25 — une ligne de commande mappée en ligne de facture. */
export interface OrderInvoiceLine {
  /** BT-126 — identifiant de ligne (unique dans la facture). */
  id: string
  /** BT-153 — désignation article. */
  name: string
  /** BT-129 — quantité, décimal non négatif jusqu'à 4 décimales (ex. "2", "1.5000"). */
  quantity: string
  /** BT-130 — code unité UN/ECE recommandation 20 (2 à 3 caractères, ex. "C62"). */
  unitCode: string
  /** BT-146 — prix unitaire HT, décimal non négatif jusqu'à 4 décimales. */
  unitPrice: string
  /** BT-151 — catégorie de TVA de la ligne. */
  vatCategory: VatCategory
  /** BT-152 — taux de TVA en pourcentage, décimal non négatif jusqu'à 4 décimales. */
  vatRate: string
  /**
   * BT-121 — code motif d'exonération VATEX, requis pour les catégories
   * exonérées (E/AE/K/G/O) si `exemptionReason` est absent. Doit appartenir
   * à la liste blanche BR-CL-22 (88 codes, cf. invoice-core `vatex.ts`) —
   * NON reproduite intégralement dans `order-mapping.schema.json` (voir la
   * note de ce fichier sur ce point précis).
   */
  exemptionReasonCode?: string
  /** BT-120 — motif d'exonération en texte libre, alternative à `exemptionReasonCode`. */
  exemptionReason?: string
  /** Discriminant biens/services, optionnel. */
  nature?: InvoiceLineNature
}

/**
 * Corps de `POST /invoices` tel qu'un connecteur doit le construire — miroir
 * de `InvoiceInput` (invoice-core). Les champs calculés par le serveur
 * (lignes enrichies de `lineNetAmount`, `vatBreakdown`, `totals`) ne figurent
 * PAS ici : ils sont produits par `buildInvoice` côté API, jamais fournis
 * par le connecteur.
 */
export interface OrderMappingPayload {
  /** BT-1 — numéro de facture, unique par tenant (409 si déjà utilisé). */
  number: string
  /** BT-2 — date d'émission, AAAA-MM-JJ. */
  issueDate: string
  /** BT-9 — date d'échéance, AAAA-MM-JJ, optionnelle. */
  dueDate?: string
  typeCode: InvoiceTypeCode
  /** BT-5 — code devise ISO 4217, 3 lettres majuscules (ex. "EUR"). */
  currency: string
  /** BG-4 — vendeur (la boutique elle-même, configurée dans le connecteur). */
  seller: Party
  /** BG-7 — acheteur (client de la commande). */
  buyer: Party
  /** BG-25 — au moins une ligne. */
  lines: OrderInvoiceLine[]
  businessProcessType?: BusinessProcessType
}
