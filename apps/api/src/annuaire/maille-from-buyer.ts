import type { Party } from '@factelec/invoice-core'
import type { Maille } from './ligne-adressage.js'

// Helpers purs Party -> Maille (D5, plan 3.3 Task 2) : EXTRAITS depuis
// `cdv-transmission.service.ts` (où ils vivaient jusqu'à 3.2) vers le domaine
// `annuaire/` — séparation de couches : l'émission (`invoices`/`worker`) doit
// dépendre de l'ANNUAIRE (le répertoire, fournisseur de primitives de
// routage), JAMAIS du domaine CDV (consommateur aval du cycle de vie, pas
// fournisseur). `CdvTransmissionService` ET `RecipientRoutingService`
// importent tous deux d'ICI (une seule définition, DRY). Extraction
// STRICTEMENT comportement-préservante — mêmes corps, aucun changement de
// logique.

// Conversion AAAA-MM-JJ (ISO — format d'`Invoice.issueDate`, invoice-core
// `isoDate`) -> AAAAMMJJ (format attendu par le `dateYmd` de
// `resolveRecipient` — `DATE_RE`/`isInForce`, nomenclature.ts/ligne-adressage.ts
// comparent des dates AAAAMMJJ à largeur fixe, SANS séparateur, par ordre
// lexicographique).
//
// ⚠ CORRECTION vs la formulation littérale du plan 3.1 (D6/Task 6 Step 1 :
// « resolveRecipient(tenantId, maille, invoice.issueDate) ») : passer
// `invoice.issueDate` TEL QUEL casserait cette comparaison — un ISO
// "2026-07-16" (10 caractères, `-` = code 45 en position 4) ne trie PAS de
// façon cohérente face à des `dateDebut`/`dateFin` AAAAMMJJ (8 caractères,
// chiffre '0'-'9' = codes 48-57 en position 4). Le D6 (« date de routage =
// issueDate de la facture ») reste l'interprétation métier retenue — SEUL le
// FORMAT de sérialisation est corrigé ici, testé sur vecteurs fixes.
export function isoDateToYmd(iso: string): string {
  return iso.replaceAll('-', '')
}

// Normalise une chaîne vide en `undefined` (leçon 2.4-T5#1, cf.
// `emptyToUndefined`, annuaire-query.schema.ts — même piège : `mailleKey`/
// `coversTarget` (ligne-adressage.ts) distinguent explicitement l'ABSENCE
// d'un identifiant d'une chaîne vide, et confondre les deux mésadresserait
// une facture). Appliqué aux champs SIREN/SIRET du buyer/seller de l'Invoice
// canonique avant toute construction de `Maille` ou tout passage au
// générateur F6. `partySchema` (invoice-core, `siren` `.optional()` + regex
// `/^\d{9}$|^\d{14}$/`) ne produit normalement JAMAIS `''` — cette
// normalisation reste une frontière défensive explicite plutôt qu'une
// confiance implicite dans un schéma amont qui pourrait évoluer.
export function normalizeToUndefined(
  v: string | undefined,
): string | undefined {
  return v === '' || v === undefined ? undefined : v
}

// Amendement A4 (plan-3-1-review.md, BINDING) : le `buyer` de l'`Invoice`
// canonique ne porte qu'UN SEUL champ d'identifiant — `siren` (BT-30/BT-47,
// « SIREN ou SIRET », regex `/^\d{9}$|^\d{14}$/`,
// packages/invoice-core/src/model/schema.ts `partySchema`) — AUCUN champ
// `siret`/`routageId`/`suffixe` dédié n'existe sur `Party`, contrairement à
// `MailleIdentifiers` (annuaire/nomenclature.ts) attendu par
// `resolveRecipient`. La `Maille` de routage se construit donc en
// INSPECTANT LA LONGUEUR de cette valeur unique :
//   - 14 chiffres (SIRET) -> `{ siren: <9 premiers chiffres>, siret: <valeur
//     complète> }` (permet une résolution SIREN_SIRET, plus spécifique
//     qu'une résolution SIREN seule) ;
//   - 9 chiffres (SIREN) -> `{ siren: <valeur> }` (`siret` ABSENT — jamais
//     `''`, cf. `normalizeToUndefined` ci-dessus : le coalesce trap
//     mésadresserait via `mailleKey`/`coversTarget`) ;
// `routageId`/`suffixe` ne sont JAMAIS dérivables d'un Invoice canonique
// (aucune source dans `Party`) — toujours absents ici : seule une ligne
// d'annuaire de niveau SIREN ou SIREN_SIRET peut donc jamais couvrir
// (`coversTarget`, ligne-adressage.ts) une cible construite depuis
// l'émission (une ligne SIREN_SIRET_ROUTAGE/SIREN_SUFFIXE ne matchera
// jamais ici — limitation connue, non couverte par ce buyer minimal).
export class BuyerIdentifierMissingError extends Error {
  constructor() {
    super(
      'buyer sans identifiant SIREN/SIRET (BT-30/BT-47 absent) — maille de routage non constructible',
    )
    this.name = 'BuyerIdentifierMissingError'
  }
}

export function buildMailleFromBuyer(buyer: Party): Maille {
  const raw = normalizeToUndefined(buyer.siren)
  if (raw === undefined) throw new BuyerIdentifierMissingError()
  if (raw.length === 14) return { siren: raw.slice(0, 9), siret: raw }
  return { siren: raw }
}
