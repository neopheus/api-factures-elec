import { create } from 'xmlbuilder2'
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js'
import type { LigneAdressage } from './ligne-adressage.js'
import { SCHEME_ID_SIREN, SCHEME_ID_SIRET } from './nomenclature.js'

// Génération XSD-valide du Flux 13 (Actualisation, PA→PPF — D3/plan 2.4).
// AnnuaireActualisation_F12-F13.xsd (via Annuaire_Commun.xsd) ne déclare
// AUCUN targetNamespace : l'instance est SANS préfixe de namespace (confirmé
// xmllint, plan-2-4-review.md §1 — corrige la formulation « même situation
// que e-reporting » du plan initial : l'e-reporting a 3 targetNamespace non
// qualifiés, l'annuaire n'en a AUCUN — le résultat pratique, une instance non
// préfixée, est identique).

// INTERPRÉTATION go-live (Task 3, hors-normé) — qualifiant du schéma d'un
// identifiant de routage (`IdLinRoutage/@qualifiant`, `IdRoutage/@qualifiant`
// — type `IdCodesRoutageType`, Annuaire_Commun.xsd, `xs:token` NON contraint
// par pattern, use="required"). L'ANNEXE 3 (Format sémantique FE annuaire
// V1.8, doc `IdRoutage/@qualifiant`) ne fixe qu'une contrainte NÉGATIVE :
// « L'identifiant de schéma d'un identifiant de routage ne peut pas prendre
// les valeurs 0002 (SIREN) ou 0009 (SIRET) ». Aucune valeur POSITIVE n'est
// normée dans la documentation disponible, et Task 1/2 (nomenclature.ts,
// ligne-adressage.ts, déjà committés) ne modélisent pas de champ qualifiant
// de routage distinct du simple `routageId: string`. Ce placeholder satisfait
// la seule contrainte structurelle du XSD (attribut requis, valeur ≠
// 0002/0009) — À CONFIRMER avec la DGFiP/PPF avant mise en production (à
// documenter au RUNBOOK, cf. plan-2-4-review.md §3, discipline identique aux
// autres marqueurs INTERPRÉTATION de ce plan : A-CONSENT, A-RESOLVE-EDGES).
export const ROUTAGE_SCHEME_ID_PLACEHOLDER = '9999' as const

export interface CodeRoutageActualisation {
  statut: string
  siret: string
  routageId: string
  nom: string
}

export interface ActualisationFlux13 {
  codesRoutage: readonly CodeRoutageActualisation[]
  lignes: readonly LigneAdressage[]
}

export function generateActualisationXml(
  actualisation: ActualisationFlux13,
): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc.ele('AnnuaireActualisation')
  if (actualisation.codesRoutage.length > 0) {
    appendCodesRoutage(root, actualisation.codesRoutage)
  }
  if (actualisation.lignes.length > 0) {
    appendLignesAnnuaire(root, actualisation.lignes)
  }
  // xmlbuilder2 échappe &/</>/" par construction (`.txt()`), y compris pour
  // un Suffixe arbitraire porté par un tenant : jamais de concaténation nue
  // (injection-proof, vérifié xmllint — cf. tests).
  return doc.end({ prettyPrint: true })
}

function appendCodesRoutage(
  root: XMLBuilder,
  codes: readonly CodeRoutageActualisation[],
): void {
  const bloc = root.ele('BlocCodesRoutage')
  for (const code of codes) {
    const cr = bloc.ele('CodeRoutage')
    cr.ele('Statut').txt(code.statut)
    cr.ele('IdSIRET').att('qualifiant', SCHEME_ID_SIRET).txt(code.siret)
    cr.ele('IdRoutage')
      .att('qualifiant', ROUTAGE_SCHEME_ID_PLACEHOLDER)
      .txt(code.routageId)
    cr.ele('Nom').txt(code.nom)
  }
}

// F13 row 20 (réglementaire, verbatim ANNEXE 3) : les lignes de MASQUAGE
// doivent être émises AVANT les lignes de DÉFINITION dans le flux. Tri
// stable (Array.prototype.sort est stable, ES2019+/toutes cibles Node visées
// par tsconfig.base.json) : préserve l'ordre relatif au sein de chaque
// Nature plutôt que de le mélanger arbitrairement.
function sortMaskingFirst(
  lignes: readonly LigneAdressage[],
): readonly LigneAdressage[] {
  return [...lignes].sort((a, b) => {
    if (a.nature === b.nature) return 0
    return a.nature === 'M' ? -1 : 1
  })
}

function appendLignesAnnuaire(
  root: XMLBuilder,
  lignes: readonly LigneAdressage[],
): void {
  const bloc = root.ele('BlocLignesAnnuaire')
  for (const ligne of sortMaskingFirst(lignes)) {
    const la = bloc.ele('LigneAnnuaire')
    la.ele('Nature').txt(ligne.nature)
    const effet = la.ele('DateEffet')
    effet.ele('DateDebut').txt(ligne.dateDebut)
    if (ligne.dateFin !== undefined) effet.ele('DateFin').txt(ligne.dateFin)
    appendInfoAdressage(la, ligne)
    la.ele('IdPlateforme').txt(ligne.plateforme)
  }
}

// InfoAdressageActualisationType (Annuaire_Commun.xsd) : identifiants
// IMBRIQUÉS sous <Identifiant> (contrairement au F14, où ils sont plats) —
// séquence XSD exacte : IdLinSIREN (requis) → IdLinSIRET? → IdLinRoutage? →
// Suffixe?.
function appendInfoAdressage(la: XMLBuilder, ligne: LigneAdressage): void {
  const info = la.ele('InfoAdressage')
  const identifiant = info.ele('Identifiant')
  identifiant
    .ele('IdLinSIREN')
    .att('qualifiant', SCHEME_ID_SIREN)
    .txt(ligne.maille.siren)
  if (ligne.maille.siret !== undefined) {
    identifiant
      .ele('IdLinSIRET')
      .att('qualifiant', SCHEME_ID_SIRET)
      .txt(ligne.maille.siret)
  }
  if (ligne.maille.routageId !== undefined) {
    identifiant
      .ele('IdLinRoutage')
      .att('qualifiant', ROUTAGE_SCHEME_ID_PLACEHOLDER)
      .txt(ligne.maille.routageId)
  }
  if (ligne.maille.suffixe !== undefined) {
    identifiant.ele('Suffixe').txt(ligne.maille.suffixe)
  }
}
