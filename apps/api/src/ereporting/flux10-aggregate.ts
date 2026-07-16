import type { Invoice, VatBreakdown } from '@factelec/invoice-core'
import { computeVatBreakdownByNature } from '@factelec/invoice-core'
import { Logger } from '@nestjs/common'
import Big from 'big.js'
import type {
  AggregatedTransaction,
  Flux10Invoice,
  TransactionsReport,
} from './flux10-model.js'
import type { Flux10Category } from './nomenclature.js'
import { mapCadreToCategories, SCHEME_ID_SIREN } from './nomenclature.js'

const logger = new Logger('flux10-aggregate')

// Dérive un TransactionsReport (TB-2) des factures d'une période, MAIS
// uniquement pour les opérations réellement e-reportables (10.3 agrégé,
// 10.1 par facture). Amendement A1 (revue Task 3) : sans classifieur,
// l'agrégation e-reporterait des opérations B2B DOMESTIQUES qui relèvent de
// l'e-invoicing (Flux 1-9), pas de l'e-reporting -> non-conformité. Le
// classifieur ci-dessous distingue les cas prévus par la spec à partir des
// seuls champs du modèle `Invoice` (buyer/seller.address.countryCode,
// buyer.siren/vatId — aucun champ dédié « assujetti/non-assujetti » n'existe
// dans le modèle : cf. heuristique documentée ci-dessous).
export type EreportingOperationClass = '10.1' | '10.3' | 'out'

// Classifie une facture au regard de l'e-reporting (PURE, aucun effet de bord).
//
// Table de vérité D4 (revue plan-3-2-review.md §Task 3, réordonnancement
// BINDING — « non-assujetti PRIME la règle pays ») :
//   1. Acheteur NON-ASSUJETTI (FR OU étranger) -> '10.3', TOUJOURS, quel que
//      soit le pays du vendeur. Sous-cas notable : un acheteur étranger
//      non-assujetti (ex. particulier allemand achetant à un vendeur FR) est
//      un EXPORT B2C, PAS du B2B international -> '10.3', PAS '10.1'.
//   2. Acheteur ASSUJETTI (SIREN ou n° TVA) ET transfrontalier (acheteur OU
//      vendeur hors FR) -> '10.1' (B2B international).
//   3. Acheteur ASSUJETTI ET domestique (les deux parties en FR) -> 'out'
//      (e-invoicing, Flux 1-9, EXCLU de l'e-reporting).
//
// ⚠️ BANNIÈRE INTERPRÉTATION + CONSÉQUENCE DGFiP-FACING (revue §A-T3-1,
// BINDING, à confirmer go-live/Annexe 7) : jusqu'à Task 2 (2.3 à 3.1), le
// '10.1' n'était NI agrégé NI émis (`invoices` toujours `[]`) — un export B2C
// mal classé en '10.1' n'avait donc AUCUNE conséquence. Task 3 change les DEUX
// choses à la fois : (a) le '10.1' est désormais ACTIVEMENT ÉMIS par facture
// (TG-8, cf. `buildFlux10Invoice`/`aggregateTransactions` ci-dessous) ; (b)
// l'export B2C est reclassé '10.3', qui est agrégé ET émis depuis Task 2. Un
// export B2C ATTEINT DONC DÉSORMAIS RÉELLEMENT LA DGFiP, FUSIONNÉ dans le même
// bucket agrégé (date‖devise‖catégorie) que le B2C purement domestique — SANS
// sous-code export dédié. Détecté et compté séparément (log, cf.
// `isExportB2C`/`exportB2CCount`) pour l'audit, mais NON séparé dans le flux
// XML tant que le bucket cible (10.3 partagé vs sous-flux export) n'est pas
// confirmé (Annexe 7, Task 10 go-live).
//
// INTERPRÉTATION PROJET (assujettissement, à confirmer au go-live, Annexe 7) :
// le modèle `Invoice` (`@factelec/invoice-core`) n'a pas de champ booléen
// dédié « assujetti ». L'heuristique retenue est la présence d'un identifiant
// fiscal acheteur : SIREN/SIRET (BT-47) OU numéro de TVA intracommunautaire
// (BT-48). Un acheteur qui ne porte NI l'un NI l'autre est traité comme une
// personne physique non-assujettie.
export function classifyEreportingOperation(
  invoice: Invoice,
): EreportingOperationClass {
  const buyerIsTaxable =
    Boolean(invoice.buyer.siren) || Boolean(invoice.buyer.vatId)
  if (!buyerIsTaxable) return '10.3'

  const crossBorder =
    invoice.buyer.address.countryCode !== 'FR' ||
    invoice.seller.address.countryCode !== 'FR'
  return crossBorder ? '10.1' : 'out'
}

// A-T3-1 (revue Task 3, MEDIUM, BINDING) : sous-ensemble des '10.3' qui est un
// EXPORT (vendeur FR, acheteur étranger) plutôt qu'un B2C purement domestique.
// PURE — n'a de sens QUE pour une facture déjà classée '10.3' (acheteur
// non-assujetti) : un acheteur assujetti étranger n'atteint jamais cette
// fonction (classé '10.1'). Détecté et compté SÉPARÉMENT (log dédié dans
// `aggregateTransactions`) même s'il finit agrégé ET ÉMIS dans le MÊME bucket
// 10.3 (date‖devise‖catégorie) que le B2C domestique — cf. bannière ci-dessus.
function isExportB2C(invoice: Invoice): boolean {
  return (
    invoice.seller.address.countryCode === 'FR' &&
    invoice.buyer.address.countryCode !== 'FR'
  )
}

export interface AggregateOptions {
  periodStart: string // AAAAMMJJ
  periodEnd: string // AAAAMMJJ
}

// Accumule une ligne de ventilation TVA (`VatBreakdown` canonique OU issue de
// `computeVatBreakdownByNature`, même forme) dans le bucket (date‖devise‖
// catégorie Flux 10). `category` est TOUJOURS fournie par l'appelant (TLB1/
// TPS1/etc, nomenclature Flux 10) — jamais dérivée de `entry.category` (qui
// porte la catégorie de TVA UNTDID 5305, ex. S/E/Z, un axe DIFFÉRENT). Big.js
// pour les sommes (BT→TT), 2 décimales (montants `amount2`).
//
// Invariant (Task 2, finding-1 ; XSD minOccurs=1 sur SubTotals) : le bucket
// est créé ET inséré dans `buckets` À L'INTÉRIEUR de cette fonction, appelée
// une fois par entrée de ventilation (jamais vide, cf. invoiceSchema :
// `vatBreakdown: z.array(vatBreakdownSchema).min(1)`, et `goods`/`services`
// ne contiennent que des buckets non-vides — cf. compute.ts) -> tout
// AggregatedTransaction émis a >= 1 subtotal. NE JAMAIS créer de bucket en
// dehors de cette fonction (un tableau `subtotals` vide produirait du XML
// XSD-invalide). Injection F1 (revue T2, binding) : PLUSIEURS FACTURES
// DISTINCTES contribuant au même (date‖devise‖catégorie) fusionnent leurs
// montants dans le MÊME bucket (clé Map partagée) — jamais d'écrasement.
function accumulateBucket(
  buckets: Map<string, AggregatedTransaction>,
  date: string,
  currency: string,
  category: Flux10Category,
  entry: Pick<VatBreakdown, 'rate' | 'taxableAmount' | 'taxAmount'>,
): void {
  const key = `${date}|${currency}|${category}`
  const bucket = buckets.get(key) ?? {
    date,
    currency,
    categoryCode: category,
    taxExclusiveAmount: '0.00',
    taxTotal: '0.00',
    subtotals: [],
  }
  bucket.taxExclusiveAmount = new Big(bucket.taxExclusiveAmount)
    .plus(entry.taxableAmount)
    .toFixed(2)
  bucket.taxTotal = new Big(bucket.taxTotal).plus(entry.taxAmount).toFixed(2)
  const subtotal = bucket.subtotals.find((s) => s.taxPercent === entry.rate)
  if (subtotal) {
    subtotal.taxableAmount = new Big(subtotal.taxableAmount)
      .plus(entry.taxableAmount)
      .toFixed(2)
    subtotal.taxTotal = new Big(subtotal.taxTotal)
      .plus(entry.taxAmount)
      .toFixed(2)
  } else {
    bucket.subtotals.push({
      taxPercent: entry.rate,
      taxableAmount: entry.taxableAmount,
      taxTotal: entry.taxAmount,
    })
  }
  buckets.set(key, bucket)
}

// Construit la forme PAR FACTURE B2B international (TG-8, 10.1) — mapping
// BT→TT ÉNUMÉRÉ par la revue du plan (plan-3-2-review.md §Task 3, A-T3-2,
// BINDING) : chaque champ ci-dessous trace un TT/TG précis (transaction.xsd,
// Annexe 6 v1.10 — annotations relevées dans le XSD lui-même). Appelée
// UNIQUEMENT pour les factures classées '10.1' (`classifyEreportingOperation`)
// — jamais pour un export B2C (classé '10.3', cf. bannière D4 ci-dessus).
// `appendInvoice` (flux10-xml.ts, écrit depuis 2.3-T2) émet déjà cette forme,
// structurellement XSD-valide (tests/unit/flux10-xml.test.ts) — AUCUNE
// modification requise côté générateur XML pour cette activation.
function buildFlux10Invoice(invoice: Invoice): Flux10Invoice {
  return {
    id: invoice.number, // TT-19 ← BT-1
    issueDate: invoice.issueDate.replaceAll('-', ''), // TT-20 ← BT-2 (AAAAMMJJ)
    typeCode: invoice.typeCode, // TT-21 ← BT-3 (UNTDID 1001, '380'/'381')
    currency: invoice.currency, // TT-22 ← BT-5
    // TT-28/29 ← BT-23 (cadre de facturation) : transaction.xsd annote TT-28
    // « Type de processus métier (cadre de facturation) » (= la valeur BT-23
    // elle-même) et TT-29 « Type de profil (e-invoicing, e-reporting, facture
    // etc..) » — cette forme EST le profil e-reporting, d'où la constante.
    // INTERPRÉTATION : BT-23 est optionnel (`invoiceInputSchema`) ; absent ->
    // chaîne vide (XSD `xs:string` non contraint, minOccurs=1 satisfait par un
    // élément vide).
    businessProcessId: invoice.businessProcessType ?? '',
    businessProcessTypeId: 'e-reporting', // TT-29
    seller: {
      // TG-12 (Seller) : identifiant vendeur + pays. INTERPRÉTATION (schemeId
      // toujours SIREN '0002', comme TG-5/Issuer) : ce plan cible le vendeur
      // FR (déclarant) comme cas nominal 10.1 ; la branche « acheteur FR
      // assujetti + vendeur étranger » de la table de vérité D4 n'a pas de
      // SIREN côté vendeur -> CompanyId vide (XSD `CompanyIdType` non
      // contraint, valide), À CONFIRMER Annexe 7 (go-live).
      companyId: invoice.seller.siren ?? '', // TT-33
      schemeId: SCHEME_ID_SIREN, // TT-33-1, '0002'
      countryId: invoice.seller.address.countryCode, // TT-35
    },
    taxAmount: invoice.totals.taxAmount, // TT-52 (@CurrencyCode = currency, TT-202)
    // TG-23 (TT-54/55/56/57) ← vatBreakdown CANONIQUE (pas de nature/catégorie
    // Flux 10) : le 10.1 par facture porte la ventilation TVA STANDARD UNTDID
    // 5305, sans axe TLB1/TPS1 — cf. bannière Task 2 (le discriminant `nature`
    // ne concerne QUE l'agrégat B2C 10.3).
    taxSubTotals: invoice.vatBreakdown.map((entry) => ({
      taxableAmount: entry.taxableAmount, // TT-54
      taxAmount: entry.taxAmount, // TT-55
      categoryCode: entry.category, // TT-56
      percent: entry.rate, // TT-57
    })),
  }
}

// Dérive un TransactionsReport des factures d'une période. null si AUCUNE
// opération e-reportable (ni 10.3 agrégée, ni 10.1 émise) — transmission à
// blanc OPTIONNELLE, D6. Chaque facture est d'abord classée
// (`classifyEreportingOperation`) : les '10.3' sont agrégées (TG-31/32), les
// '10.1' sont émises PAR FACTURE (TG-8, activation Task 3). Les 'out' (B2B
// domestique, e-invoicing) sont EXCLUES — ni comptées, ni émises.
export function aggregateTransactions(
  invoices: Invoice[],
  opts: AggregateOptions,
): TransactionsReport | null {
  const classified = invoices.map((invoice) => ({
    invoice,
    operationClass: classifyEreportingOperation(invoice),
  }))
  const eligible = classified
    .filter((c) => c.operationClass === '10.3')
    .map((c) => c.invoice)
  const crossBorderTaxable = classified
    .filter((c) => c.operationClass === '10.1')
    .map((c) => c.invoice)

  // Groupage (date ‖ devise ‖ catégorie) — Big.js pour les sommes (BT→TT).
  const buckets = new Map<string, AggregatedTransaction>()
  let deferredMixed = 0
  let exportB2CCount = 0
  for (const invoice of eligible) {
    if (isExportB2C(invoice)) exportB2CCount++
    // INTERPRÉTATION PROJET (à confirmer au go-live, Annexe 7) : la date de
    // transaction TT-77 = issueDate (BT-2) de la facture.
    const date = invoice.issueDate.replaceAll('-', '')
    const categories = invoice.businessProcessType
      ? mapCadreToCategories(invoice.businessProcessType)
      : // INTERPRÉTATION PROJET (à confirmer au go-live, Annexe 7) : catégorie
        // par défaut si BT-23 (cadre de facturation) absent -> TLB1 (livraison
        // de biens).
        (['TLB1'] as const)

    if (categories.length > 1) {
      // Cadre MIXTE (M1/M2/M4, TLB1+TPS1) — Task 2, résolution du différé
      // 2.3-T3 : avec le discriminant `nature` de ligne (Task 1), on
      // construit la VRAIE ventilation TLB1(biens)/TPS1(services), total
      // conservé, JAMAIS doublée (`computeVatBreakdownByNature`, total
      // conservé par construction — cf. compute.ts). Une facture dont AU
      // MOINS une ligne n'a pas de `nature` reste différée à l'identique de
      // 2.3 (skip typé + log ; aucune ventilation partielle fabriquée).
      const byNature = computeVatBreakdownByNature(invoice)
      if (!byNature.complete) {
        deferredMixed++
        continue
      }
      // Injection T1(b) ratifiée : `goods`/`services` sont des `VatBreakdown[]`
      // (même forme que la ventilation canonique), mais l'ASYMÉTRIE documentée
      // dans `computeVatBreakdownByNature` (le bucket `services`, dérivé par
      // soustraction, ne porte JAMAIS `exemptionReasonCode`/`exemptionReason`,
      // contrairement à `goods`, recalculé) est SANS CONSÉQUENCE ici :
      // `accumulateBucket` ne consomme QUE `rate`/`taxableAmount`/`taxAmount`,
      // et la `category` Flux 10 (TLB1/TPS1) est TOUJOURS celle passée en
      // paramètre par ce bloc, jamais `entry.category` (S/E/Z…, un axe TVA
      // distinct de la nomenclature Flux 10 TT-81).
      for (const entry of byNature.goods) {
        accumulateBucket(buckets, date, invoice.currency, 'TLB1', entry)
      }
      for (const entry of byNature.services) {
        accumulateBucket(buckets, date, invoice.currency, 'TPS1', entry)
      }
      continue
    }

    // `categories.length === 1` ici (mixte traité + `continue` ci-dessus ;
    // `mapCadreToCategories`/le repli par défaut ne renvoient jamais un
    // tableau vide) — assertion non-null au lieu d'une garde `undefined`
    // qui introduirait une branche morte, non atteignable (100 % branches).
    // biome-ignore lint/style/noNonNullAssertion: catégorie unique garantie non-vide par construction (cf. commentaire ci-dessus) ; une garde ici serait une branche morte non testable.
    const category = categories[0]!
    for (const vatBreakdown of invoice.vatBreakdown) {
      accumulateBucket(buckets, date, invoice.currency, category, vatBreakdown)
    }
  }

  if (deferredMixed > 0) {
    logger.warn(
      `${deferredMixed} facture(s) à cadre mixte différée(s) (ligne sans nature, cf. computeVatBreakdownByNature)`,
    )
  }

  if (exportB2CCount > 0) {
    // Bannière D4/A-T3-1 (BINDING, revue plan-3-2-review.md §Task 3) : ces
    // factures sont désormais AGRÉGÉES ET ÉMISES (co-mêlées au B2C domestique,
    // même bucket date‖devise‖catégorie) — PAS de sous-code export dédié à ce
    // stade. Détection/comptage explicite pour l'audit go-live (Annexe 7).
    logger.warn(
      `${exportB2CCount} facture(s) export B2C (vendeur FR, acheteur étranger non-assujetti) agrégée(s) ET ÉMISE(s) dans le bucket 10.3 domestique (interprétation à confirmer Annexe 7, go-live — aucun sous-code export dédié aujourd'hui).`,
    )
  }

  // TG-8 (10.1, B2B international) : ACTIVATION Task 3 — classifié depuis 2.3,
  // désormais ÉMIS par facture (mapping BT→TT énuméré, `buildFlux10Invoice`).
  const flux10Invoices = crossBorderTaxable.map(buildFlux10Invoice)

  // Période sans AUCUNE opération e-reportable (ni agrégat 10.3, ni facture
  // 10.1 émise) -> transmission à blanc (null, D6). Garantit qu'un
  // TransactionsReport émis porte toujours >= 1 agrégat OU >= 1 facture 10.1.
  if (buckets.size === 0 && flux10Invoices.length === 0) return null

  return {
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    invoices: flux10Invoices,
    aggregated: [...buckets.values()],
  }
}
