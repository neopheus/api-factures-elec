import { create } from 'xmlbuilder2'
import { statusByCode } from '../invoices/lifecycle-status.js'

// Génération du Flux 6 (message CDV — cycle de vie facture, statuts
// 200-213 du Tableau 8) au format sémantique CDAR (UN/CEFACT SCRDM CI
// Cross Domain Application Response message — Dossier général v3.2 §3.6.4,
// footnote 102). Mapping vérifié contre
// `Annexe 2 - Format sémantique FE CDV - Flux 6 - V2.3.xlsx`, onglet
// « CDV FE - CI ARM » (313 lignes, parsé openpyxl).
//
// ⚠ CADRAGE HONNÊTE (D3, plan 3.1) : il n'existe AUCUN XSD DGFiP pour le
// Flux 6 / CDV / CDAR (arbre `3- XSD_v3.2/` = Annuaire + E-reporting +
// E-invoicing SEULEMENT, vérifié in situ ; `Changelog_XSD.md` n'énumère que
// ces 3 familles). L'XSD UN/CEFACT CDAR externe n'est PAS vendorisé
// (`docs/reglementaire` lecture seule, aucun fetch, aucune dépendance
// ajoutée). `validateFlux6Structure` ci-dessous est donc une validation
// STRUCTURELLE EN CODE (présence des chemins obligatoires + code ∈
// Tableau 8 + horodates `^[0-9]{14}$` + `@schemeID` ∈ ICD 6523 vérifié) —
// PAS une validation de schéma. Contraste explicite avec les Flux
// 10/13/14 (2.3/2.4) qui DISPOSENT d'un XSD DGFiP réel (posture PAF, 2.2).
//
// ⚠ AMENDEMENT A2 (contrôleur, plan-3-1-review.md, RATIFIÉ) : les 3 blocs
// de parties (`SenderTradeParty`/`IssuerTradeParty`/`RecipientTradeParty`)
// sont nichés sous `/rsm:ExchangedDocument/`, PAS sous
// `/rsm:AcknowledgementDocument/` (le plan initial les plaçait à tort sous
// AcknowledgementDocument — corrigé ici contre le xlsx réel, chemins
// vérifiés ci-dessous). Les champs propres au STATUT (MDT-78/87/105/126)
// restent, eux, sous `/rsm:AcknowledgementDocument/`.
//
// Chemins vérifiés (xlsx, colonne I "Chemin", ID en commentaire) :
//   MDT-3   R  /rsm:ExchangedDocumentContext/ram:GuidelineSpecifiedDocumentContextParameter/ram:ID
//   MDT-8   R  /rsm:ExchangedDocument/ram:IssueDateTime/udt:DateTimeString        (horodate MESSAGE)
//   MDT-8-1 R  .../udt:DateTimeString/@format                (UNTDID 2379, 204 = AAAAMMJJHHMMSS)
//   MDT-17/18/19 O/R/R  /rsm:ExchangedDocument/ram:SenderTradeParty/{ram:ID,ram:GlobalID,@schemeID}
//   MDT-36/37/38 O/R/R  /rsm:ExchangedDocument/ram:IssuerTradeParty/{...}
//   MDT-55/56/57 O/O/O  /rsm:ExchangedDocument/ram:RecipientTradeParty/{...}
//   MDT-74  R  /rsm:AcknowledgementDocument/ram:MultipleReferencesIndicator/udt:Indicator (1..1, FIXE 'False' — revue T2 F-1)
//   MDT-78  R  /rsm:AcknowledgementDocument/ram:IssueDateTime/udt:DateTimeString  (horodate STATUT)
//   MDT-78-1 R .../udt:DateTimeString/@format                (idem MDT-8-1, 204)
//   MDT-87  R  /rsm:AcknowledgementDocument/ram:ReferenceReferencedDocument/ram:IssuerAssignedID
//   MDT-105 R  /rsm:AcknowledgementDocument/ram:ReferenceReferencedDocument/ram:ProcessConditionCode
//   MDT-126 O  /rsm:AcknowledgementDocument/ram:ReferenceReferencedDocument/ram:SpecifiedDocumentStatus/ram:IncludedNote/ram:Content
//
// Namespaces `rsm:`/`ram:`/`udt:` — INTERPRÉTATION PROJET (A1 du plan) :
// l'Annexe 2 donne les CHEMINS (préfixés) mais AUCUNE URN (colonnes
// vérifiées : Notice/Version/CDV FE - CI ARM — grep négatif sur
// `urn:`/`xmlns` dans tout le classeur). Les URN ci-dessous suivent la
// convention UN/CEFACT CII/SCRDM standard (même famille rsm/ram/udt que
// CrossIndustryInvoice, dont seule la partie "message" de l'URN rsm change) :
// défendable, non normée par la DGFiP dans ce dépôt — à confirmer avant
// prod si la DGFiP publie un jour un XSD/registre officiel (D3, item
// Xavier). La validation étant structurelle (présence de chemins, pas de
// XSD), un désaccord d'URN n'affecte pas `validateFlux6Structure`.
const NS_RSM =
  'urn:un:unece:uncefact:data:standard:CrossIndustryApplicationResponse:100'
const NS_RAM =
  'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100'
const NS_UDT = 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100'

// UNTDID 2379, valeur 204 = AAAAMMJJHHMMSS (MDT-8-1/MDT-78-1, xlsx vérifié
// — Liste valeurs & Nomenclatures : "(UNTDID 2379) Valeur = 204
// :AAAAMMJJHHMMSS"). Identique aux deux occurrences (MDT-8 et MDT-78).
const DATETIME_FORMAT_CODE = '204'

// MDT-3/MDG-3 (profil du message CDV) — la colonne "Liste valeurs &
// Nomenclatures" est VIDE pour MDT-3 dans l'Annexe 2 : aucune valeur n'est
// normée par la DGFiP. Définition métier (xlsx) : « Permet de préciser le
// profil du message CDV (e-invoicing, flux annuaire, e-reporting ou
// données réglementaires de facture) ». Ce module ne traite QUE le cycle
// de vie FACTURE (statuts 200-213, Tableau 8) — jamais e-reporting/
// annuaire. INTERPRÉTATION PROJET (miroir `ROUTAGE_SCHEME_ID_PLACEHOLDER`,
// flux13-xml.ts) : littéral stable identifiant ce profil, à confirmer avec
// la DGFiP/PPF avant mise en production.
export const CDV_INVOICE_PROFILE_ID = 'FACTURE' as const

// ICD 6523 (MDT-18/37/56 — xlsx vérifié : "0238 = matricule PDP/PPF",
// "0002 = SIREN", "0009 = SIRET", "0224 = Code routage"). Le plan (Task 2
// Step 2) fixe l'affectation : SenderTradeParty = matricule PDP/PPF
// (0238) ; Issuer/RecipientTradeParty = SIREN (0002). `Flux6Message` ne
// porte qu'un identifiant brut (pas de schemeId dédié par partie) — SIRET/
// code-routage pour l'émetteur/destinataire ne sont pas modélisés ici
// (extension future si besoin, hors périmètre Task 2).
//
// SOUS-ENSEMBLE ÉMIS (revue T2 F-2/F-3, honnêteté) : ce générateur émet le
// sous-ensemble MINIMAL des MDT Requis pour porter UN statut d'UNE facture.
// MDT Requis-PPF NON émis (interface figée du plan, à compléter si le PPF
// les exige à l'homologation) : MDT-4 (ID message), MDT-5, MDT-21, MDT-40,
// MDT-91, MDT-95, MDT-97. Par ailleurs Issuer/Recipient sont OPTIONNELS
// dans l'interface alors que la source les note R (Recipient 1..n côté
// CDAR) — assoupli sciemment tant que l'adaptateur transport réel (différé)
// n'impose pas la forme finale ; à resserrer à l'homologation.
const ICD_MATRICULE_PDP_PPF = '0238'
const ICD_SIREN = '0002'
const VALID_SCHEME_IDS = new Set(['0002', '0009', '0224', '0238'])

const HORODATE_RE = /^[0-9]{14}$/

export interface Flux6Message {
  senderMatricule: string
  invoiceRef: string
  statusCode: number
  statusHorodate: string
  messageHorodate: string
  motif?: string
  issuer?: string
  recipient?: string
}

export interface Flux6StructureValidation {
  valid: boolean
  errors: string
}

function assertHorodate(value: string, label: string): void {
  if (!HORODATE_RE.test(value)) {
    throw new Error(
      `${label} mal formée (attendu AAAAMMJJHHMMSS, 14 chiffres) : "${value}"`,
    )
  }
}

// Génère le message CrossIndustryApplicationResponse (Flux 6 / CDAR) pour
// un statut de cycle de vie facture. `xmlbuilder2` échappe `&`/`<`/`>` par
// construction (`.txt()`), jamais de concaténation nue (injection-proof —
// miroir flux10-xml.ts/flux13-xml.ts).
export function generateFlux6Cdar(msg: Flux6Message): string {
  if (statusByCode(msg.statusCode) === null) {
    throw new Error(
      `code statut CDV inconnu (hors Tableau 8, 200-213) : ${msg.statusCode}`,
    )
  }
  assertHorodate(msg.statusHorodate, 'horodate de statut (MDT-78)')
  assertHorodate(msg.messageHorodate, 'horodate de message (MDT-8)')

  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc.ele('rsm:CrossIndustryApplicationResponse', {
    'xmlns:rsm': NS_RSM,
    'xmlns:ram': NS_RAM,
    'xmlns:udt': NS_UDT,
  })

  // rsm:ExchangedDocumentContext (MDB-1) — MDT-3 profil (MDG-3).
  root
    .ele('rsm:ExchangedDocumentContext')
    .ele('ram:GuidelineSpecifiedDocumentContextParameter')
    .ele('ram:ID')
    .txt(CDV_INVOICE_PROFILE_ID)

  // rsm:ExchangedDocument (MDB-2) — MDT-8 horodate MESSAGE + les 3 parties
  // (A2 : nichées ICI, pas sous AcknowledgementDocument).
  const exchangedDocument = root.ele('rsm:ExchangedDocument')
  exchangedDocument
    .ele('ram:IssueDateTime')
    .ele('udt:DateTimeString', { format: DATETIME_FORMAT_CODE })
    .txt(msg.messageHorodate)

  // MDT-17/18/19 : émetteur du MESSAGE CDV (le PA), matricule PDP/PPF.
  exchangedDocument
    .ele('ram:SenderTradeParty')
    .ele('ram:GlobalID', { schemeID: ICD_MATRICULE_PDP_PPF })
    .txt(msg.senderMatricule)

  // MDT-36/37/38 : émetteur de la FACTURE référencée (SIREN), optionnel —
  // pas toujours connu selon l'objet référencé.
  if (msg.issuer !== undefined) {
    exchangedDocument
      .ele('ram:IssuerTradeParty')
      .ele('ram:GlobalID', { schemeID: ICD_SIREN })
      .txt(msg.issuer)
  }

  // MDT-55/56/57 : destinataire de la FACTURE référencée (SIREN), optionnel.
  if (msg.recipient !== undefined) {
    exchangedDocument
      .ele('ram:RecipientTradeParty')
      .ele('ram:GlobalID', { schemeID: ICD_SIREN })
      .txt(msg.recipient)
  }

  // rsm:AcknowledgementDocument — MDT-78 horodate STATUT, MDT-87 réf.
  // facture/flux, MDT-105 code statut, MDT-126 motif (optionnel).
  const acknowledgementDocument = root.ele('rsm:AcknowledgementDocument')
  // MDT-74 (revue T2 F-1) : Requis 1..1 (CDAR ET PPF), VALEUR FIXE 'False'
  // (« un message = un statut d'une facture », pas de multi-références),
  // PREMIER enfant d'AcknowledgementDocument (ordre xlsx).
  acknowledgementDocument
    .ele('ram:MultipleReferencesIndicator')
    .ele('udt:Indicator')
    .txt('False')
  acknowledgementDocument
    .ele('ram:IssueDateTime')
    .ele('udt:DateTimeString', { format: DATETIME_FORMAT_CODE })
    .txt(msg.statusHorodate)

  const referencedDocument = acknowledgementDocument.ele(
    'ram:ReferenceReferencedDocument',
  )
  referencedDocument.ele('ram:IssuerAssignedID').txt(msg.invoiceRef)
  referencedDocument.ele('ram:ProcessConditionCode').txt(String(msg.statusCode))

  if (msg.motif !== undefined) {
    referencedDocument
      .ele('ram:SpecifiedDocumentStatus')
      .ele('ram:IncludedNote')
      .ele('ram:Content')
      .txt(msg.motif)
  }

  return doc.end({ prettyPrint: true })
}

// Extrait le contenu d'un bloc `<tag>...</tag>` de premier niveau (non
// auto-fermant). `null` si absent OU auto-fermant (`<tag/>`, sans enfants
// possibles) — les deux cas signalent l'absence du bloc requis pour la
// suite de la validation structurelle.
function extractBlock(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`)
  return xml.match(re)?.[1] ?? null
}

// Formate une cause de parsing échoué (précédent : annuaire-xsd-validator.ts
// / ereporting-xsd-validator.ts, `cause instanceof Error ? cause.message :
// String(cause)`). `create()` (xmlbuilder2) lève en pratique toujours une
// Error réelle (vérifié empiriquement) — le repli `String(err)` couvre
// néanmoins tout throw non standard (contrat `catch (err: unknown)`).
// Interne, exporté pour test (miroir `ALLOWED_TRANSITIONS`, Task 1) : ne
// dépend pas du comportement interne de xmlbuilder2 pour être vérifié.
export function formatParsingError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Validation STRUCTURELLE (posture PAF, D3 — aucun XSD DGFiP pour le
// Flux 6). Vérifie, PAR PRÉSENCE DE CHEMINS (regex sur les balises, pas
// une validation XPath/schéma stricte — cohérence honnête avec l'absence
// de XSD) : élément racine, blocs `ExchangedDocument`/
// `AcknowledgementDocument` (A2), MDT-105 (code ∈ Tableau 8), MDT-87,
// MDT-8/MDT-78 (horodates `^[0-9]{14}$`), `@schemeID` ∈ ICD 6523.
export function validateFlux6Structure(xml: string): Flux6StructureValidation {
  const errors: string[] = []

  // Well-formedness minimale : `create()` lève sur un XML structurellement
  // invalide (attribut mal fermé, nom invalide...). Round-trip PARSING
  // seul, aucune re-sérialisation d'un texte désérialisé — le bug de
  // ré-échappement d'entités (`decodeXmlEntities`, precedent flux14-parse)
  // ne s'applique qu'à une lecture-puis-réécriture d'objet, absente ici.
  try {
    create(xml)
  } catch (err) {
    return {
      valid: false,
      errors: `XML mal formé : ${formatParsingError(err)}`,
    }
  }

  if (!/<rsm:CrossIndustryApplicationResponse(?:\s[^>]*)?(?:\/>|>)/.test(xml)) {
    errors.push('racine rsm:CrossIndustryApplicationResponse absente')
  }

  const exchangedDocumentBlock = extractBlock(xml, 'rsm:ExchangedDocument')
  if (exchangedDocumentBlock === null) {
    errors.push(
      'bloc rsm:ExchangedDocument absent (MDT-8 horodate message, parties A2)',
    )
  } else {
    // `noUncheckedIndexedAccess` (tsconfig strict) type un groupe capturé
    // `string | undefined` même si le `match` lui-même est non-null (le
    // groupe est pourtant TOUJOURS présent à l'exécution — `(...)`
    // obligatoire, jamais `(...)?`) : on borne donc explicitement le
    // `undefined` plutôt que de faire confiance à `!match`.
    const messageDateValue = exchangedDocumentBlock.match(
      /<udt:DateTimeString[^>]*>([^<]*)<\/udt:DateTimeString>/,
    )?.[1]
    if (messageDateValue === undefined || !HORODATE_RE.test(messageDateValue)) {
      errors.push(
        'udt:DateTimeString (MDT-8, horodate message) absente ou mal formée dans ExchangedDocument',
      )
    }
  }

  const acknowledgementDocumentBlock = extractBlock(
    xml,
    'rsm:AcknowledgementDocument',
  )
  if (acknowledgementDocumentBlock === null) {
    errors.push('bloc rsm:AcknowledgementDocument absent (MDT-78/87/105/126)')
  } else {
    const statusDateValue = acknowledgementDocumentBlock.match(
      /<udt:DateTimeString[^>]*>([^<]*)<\/udt:DateTimeString>/,
    )?.[1]
    if (statusDateValue === undefined || !HORODATE_RE.test(statusDateValue)) {
      errors.push(
        'udt:DateTimeString (MDT-78, horodate statut) absente ou mal formée dans AcknowledgementDocument',
      )
    }

    if (
      !/<ram:IssuerAssignedID>[^<]+<\/ram:IssuerAssignedID>/.test(
        acknowledgementDocumentBlock,
      )
    ) {
      errors.push(
        'ram:IssuerAssignedID (MDT-87) absent du bloc AcknowledgementDocument',
      )
    }

    const processConditionValue = acknowledgementDocumentBlock.match(
      /<ram:ProcessConditionCode>([^<]*)<\/ram:ProcessConditionCode>/,
    )?.[1]
    if (processConditionValue === undefined) {
      errors.push(
        'ram:ProcessConditionCode (MDT-105) absent du bloc AcknowledgementDocument',
      )
    } else if (
      !/^[0-9]+$/.test(processConditionValue) ||
      statusByCode(Number(processConditionValue)) === null
    ) {
      errors.push(
        `code statut "${processConditionValue}" hors Tableau 8 (MDT-105)`,
      )
    }
  }

  for (const match of xml.matchAll(/schemeID="([^"]*)"/g)) {
    const schemeIdValue = match[1]
    if (schemeIdValue === undefined || !VALID_SCHEME_IDS.has(schemeIdValue)) {
      errors.push(
        `@schemeID hors ICD 6523 attendu {0002,0009,0224,0238} : "${schemeIdValue}"`,
      )
    }
  }

  return { valid: errors.length === 0, errors: errors.join('; ') }
}
