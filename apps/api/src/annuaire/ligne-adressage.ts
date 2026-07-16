import {
  type MailleIdentifiers,
  type MailleLevel,
  mailleLevelOf,
  type Nature,
} from './nomenclature.js'

// Ligne d'adressage — modèle pur de validité & résolution de routage (D4,
// Task 2 plan 2.4 ; amendement contrôleur A-RESOLVE-EDGES,
// .superpowers/sdd/plan-2-4-review.md). C'est la brique dont dépendra le
// ROUTAGE des factures (Tasks 3/5/7-9) : une erreur ici MÉSADRESSE une
// facture — chaque branche ci-dessous est réglementairement sensible et
// délibérément testée à 100 %.
//
// Validité semi-ouverte [DateDebut, DateFin) (ANNEXE 3 F13 rows 23-24,
// verbatim) : la date de DÉBUT est INCLUSE, la date de FIN est EXCLUE.
// « Si aucune ligne d'annuaire ... n'est en vigueur à cette date, aucune
// facture ne pourra lui être adressée » (F13 row 24) → resolveRecipient
// lève RecipientUnaddressableError plutôt que de retourner undefined : un
// échec de routage doit être un ÉCHEC EXPLICITE ET TYPÉ, jamais une valeur
// absente qu'un appelant pourrait laisser filer silencieusement.
//
// ⚠ AVERTISSEMENT D'INTERPRÉTATION — hiérarchie de spécificité des mailles
// (F13 row 25 + Task 1 mailleLevelOf), à lire avec la même rigueur que le
// commentaire Figure 59 de ereporting-lifecycle.ts (source non tranchante
// → modélisation explicite et documentée) : SIREN < SIREN_SIRET <
// {SIREN_SIRET_ROUTAGE, SIREN_SUFFIXE}. Ces deux derniers niveaux NE SONT
// PAS un ordre total entre eux — ce sont deux axes MUTUELLEMENT EXCLUSIFS
// (nomenclature.ts, mailleLevelOf) et donc traités ICI à RANG ÉGAL, le
// plus élevé de la hiérarchie. Si les deux venaient malgré tout à matcher
// la même cible au même rang (cas non prévu par la spec écrite — le
// miroir F14 n'est pas contraint par l'unicité locale, cf. point suivant),
// resolveRecipient lève AmbiguousResolutionError plutôt que de choisir
// arbitrairement l'un des deux : un mauvais choix silencieux mésadresserait
// une facture, un échec typé alerte l'appelant.
//
// INTERPRÉTATION — concurrence de lignes D à la MÊME maille exacte
// (A-RESOLVE-EDGES point 1, ratifiée contrôleur) : le miroir de
// consultation (Task 9) alimente ce module depuis le F14 PPF — PAS
// contraint par l'unicité locale (index partiel Task 5) — il PEUT donc
// contenir deux Définitions en vigueur simultanément à la même date sur la
// même maille exacte. Choix retenu (non tranché par la spec) : la
// DateDebut la plus RÉCENTE l'emporte (représente la définition la plus à
// jour) ; en cas d'égalité stricte de DateDebut, la situation est
// authentiquement indéterminée → AmbiguousResolutionError plutôt qu'un
// choix arbitraire silencieux.
//
// INTERPRÉTATION — masquage-repli (A-RESOLVE-EDGES point 2) : une ligne
// Nature='M' en vigueur RETIRE de la résolution la/les Définition(s)
// partageant EXACTEMENT sa maille (même mailleKey) — mais NE bloque PAS le
// repli sur une Définition MOINS SPÉCIFIQUE restée en vigueur (ex. un
// masquage SIREN_SIRET laisse résoudre vers une Définition SIREN si elle
// existe). La spec ne tranche pas explicitement ce repli ; le choix retenu
// (repli plutôt que non-adressabilité immédiate dès qu'une maille précise
// est masquée) maximise la délivrabilité tout en respectant le masquage
// explicite de la maille visée.

export type Maille = MailleIdentifiers

export interface LigneAdressage {
  maille: Maille
  nature: Nature
  dateDebut: string // AAAAMMJJ, inclus
  dateFin?: string // AAAAMMJJ, exclu — absent = en vigueur indéfiniment
  plateforme: string // matricule PPF (4 chiffres, nomenclature.ts)
}

// Sentinelle « toujours après toute date réelle AAAAMMJJ » — permet de
// traiter une absence de DateFin comme un intervalle ouvert dans les
// comparaisons lexicographiques (largeur fixe, valide comme en 2.3
// invoicesForPeriod / ereporting/period.ts).
const OPEN_ENDED = '99991231'

// Clé canonique d'une maille — identique pour deux mailles portant les
// mêmes identifiants, quelle que soit la Nature de la ligne qui les porte.
// Volontairement SANS `nature` : c'est ce qui permet à une ligne Nature='M'
// de masquer une ligne Nature='D' de MÊME maille (cf. resolveRecipient).
// À ne pas confondre avec la clé unique du MIROIR de persistance (Task
// 5/9), qui DOIT inclure `nature` pour éviter une collision D/M en base
// (A-MIRROR-KEY) — préoccupation de couche différente (upsert SQL), sans
// rapport avec cette égalité logique en mémoire.
export function mailleKey(maille: Maille): string {
  return [
    maille.siren,
    maille.siret ?? '',
    maille.routageId ?? '',
    maille.suffixe ?? '',
  ].join('|')
}

// isInForce = « en vigueur à dateYmd » au sens strict du F13 row 23-24 :
// debut ≤ d ET (pas de fin OU d < fin).
export function isInForce(ligne: LigneAdressage, dateYmd: string): boolean {
  return (
    ligne.dateDebut <= dateYmd &&
    (ligne.dateFin === undefined || dateYmd < ligne.dateFin)
  )
}

// overlaps = deux lignes de MÊME maille dont les intervalles semi-ouverts
// [debut, fin) sont sécants. Deux intervalles [s1,e1) et [s2,e2) sont
// sécants ssi s1 < e2 ET s2 < e1 (des bornes jointives — s2 === e1 — ne se
// chevauchent PAS, cohérent avec le semi-ouvert).
export function overlaps(a: LigneAdressage, b: LigneAdressage): boolean {
  if (mailleKey(a.maille) !== mailleKey(b.maille)) return false
  const aEnd = a.dateFin ?? OPEN_ENDED
  const bEnd = b.dateFin ?? OPEN_ENDED
  return a.dateDebut < bEnd && b.dateDebut < aEnd
}

export class RecipientUnaddressableError extends Error {
  constructor(
    readonly maille: Maille,
    readonly dateYmd: string,
  ) {
    super(
      `aucune ligne d'annuaire en vigueur pour la maille ${mailleKey(maille)} à la date ${dateYmd} — destinataire non adressable (F13 row 24)`,
    )
    this.name = 'RecipientUnaddressableError'
  }
}

// Ajout au-delà de l'interface littérale du plan (amendement A-RESOLVE-EDGES,
// contrôleur) : un départage authentiquement indéterminé (D concurrentes de
// même DateDebut, ou deux mailles distinctes à rang de spécificité égal)
// doit échouer de façon TYPÉE plutôt que de choisir arbitrairement — le
// coût d'un mauvais choix silencieux est une facture mésadressée.
export class AmbiguousResolutionError extends Error {
  constructor(
    readonly maille: Maille,
    readonly dateYmd: string,
  ) {
    super(
      `résolution de routage indéterminée pour la maille ${mailleKey(maille)} à la date ${dateYmd} (lignes concurrentes non départagées — INTERPRÉTATION A-RESOLVE-EDGES)`,
    )
    this.name = 'AmbiguousResolutionError'
  }
}

// Rang de spécificité (cf. avertissement d'interprétation en tête de
// fichier) : SIREN_SIRET_ROUTAGE et SIREN_SUFFIXE partagent le rang 2 —
// deux axes mutuellement exclusifs, jamais l'un au-dessus de l'autre.
const MAILLE_LEVEL_RANK = {
  SIREN: 0,
  SIREN_SIRET: 1,
  SIREN_SIRET_ROUTAGE: 2,
  SIREN_SUFFIXE: 2,
} as const satisfies Record<MailleLevel, number>

function rankOf(ligne: LigneAdressage): number {
  return MAILLE_LEVEL_RANK[mailleLevelOf(ligne.maille)]
}

// Une ligne « couvre » la cible ssi son SIREN correspond ET, pour son
// propre niveau de maille (mailleLevelOf, Task 1), ses identifiants
// propres au niveau correspondent EXACTEMENT à ceux de la cible. Une ligne
// SIREN couvre donc toute cible du même SIREN (repli le plus général) ;
// une ligne SIREN_SIRET_ROUTAGE ne couvre que la cible exacte SIRET+routage.
//
// Exportée (Task 5, amendement A-CONSENT) : `findActiveConsent` réutilise
// EXACTEMENT cette même notion de couverture « maille égale ou plus large »
// pour le consentement — même hiérarchie SIREN < SIREN_SIRET <
// {SIREN_SIRET_ROUTAGE, SIREN_SUFFIXE} que la résolution de routage, plutôt
// que de redériver une définition subtilement différente dans le
// repository. Marqué INTERPRÉTATION go-live comme A-CONSENT (§3.5.5.5, la
// spec ne norme pas la granularité de couverture du consentement).
export function coversTarget(target: Maille, ligneMaille: Maille): boolean {
  if (ligneMaille.siren !== target.siren) return false
  const level = mailleLevelOf(ligneMaille)
  if (level === 'SIREN') return true
  if (level === 'SIREN_SIRET') return ligneMaille.siret === target.siret
  if (level === 'SIREN_SIRET_ROUTAGE') {
    if (ligneMaille.siret !== target.siret) return false
    return ligneMaille.routageId === target.routageId
  }
  return ligneMaille.suffixe === target.suffixe // SIREN_SUFFIXE, dernier niveau restant
}

// Sélectionne l'élément de `items` maximisant `keyOf` (comparaison
// lexicographique/numérique croissante). Signale une égalité STRICTE au
// sommet via `tied` plutôt que de choisir arbitrairement — c'est
// l'appelant qui décide s'il s'agit d'une erreur de résolution.
// Contrat interne : `items` non vide (les deux appelants ne l'invoquent
// que sur des listes déjà garanties non vides par construction).
function pickMaxByDateDebut(items: readonly LigneAdressage[]): {
  winner: LigneAdressage
  tied: boolean
} {
  const winner = items.reduce((top, candidate) =>
    candidate.dateDebut > top.dateDebut ? candidate : top,
  )
  const tied =
    items.filter((item) => item.dateDebut === winner.dateDebut).length > 1
  return { winner, tied }
}

function pickMaxByRank(items: readonly LigneAdressage[]): {
  winner: LigneAdressage
  tied: boolean
} {
  const winner = items.reduce((top, candidate) =>
    rankOf(candidate) > rankOf(top) ? candidate : top,
  )
  const tied =
    items.filter((item) => rankOf(item) === rankOf(winner)).length > 1
  return { winner, tied }
}

// Départage intra-maille (A-RESOLVE-EDGES #1) : regroupe les candidates
// par mailleKey exacte puis retient, par groupe, la Définition de
// DateDebut la plus récente (échec typé si égalité stricte).
function winnersByMailleKey(
  candidates: readonly LigneAdressage[],
  maille: Maille,
  dateYmd: string,
): LigneAdressage[] {
  const byKey = new Map<string, LigneAdressage[]>()
  for (const candidate of candidates) {
    const key = mailleKey(candidate.maille)
    const bucket = byKey.get(key)
    if (bucket) bucket.push(candidate)
    else byKey.set(key, [candidate])
  }
  const winners: LigneAdressage[] = []
  for (const bucket of byKey.values()) {
    const { winner, tied } = pickMaxByDateDebut(bucket)
    if (tied) throw new AmbiguousResolutionError(maille, dateYmd)
    winners.push(winner)
  }
  return winners
}

// Départage inter-maille (hiérarchie de spécificité) : parmi les
// gagnants par maille, retient le rang le plus élevé (échec typé si
// égalité de rang entre mailles distinctes, cf. avertissement d'en-tête).
function mostSpecific(
  winners: readonly LigneAdressage[],
  maille: Maille,
  dateYmd: string,
): LigneAdressage {
  if (winners.length === 0)
    throw new RecipientUnaddressableError(maille, dateYmd)
  const { winner, tied } = pickMaxByRank(winners)
  if (tied) throw new AmbiguousResolutionError(maille, dateYmd)
  return winner
}

// Résout le matricule de plateforme destinataire pour `maille` à
// `dateYmd` : filtre les Définitions ('D') en vigueur couvrant la cible,
// retire celles masquées par une ligne 'M' en vigueur de MÊME maille
// exacte (repli sur une définition moins spécifique le cas échéant),
// départage les concurrentes (DateDebut le plus récent), puis retient la
// maille la plus spécifique. Lève RecipientUnaddressableError si aucune
// ligne ne couvre la cible, AmbiguousResolutionError si un départage est
// authentiquement indéterminé.
export function resolveRecipient(
  lignes: readonly LigneAdressage[],
  maille: Maille,
  dateYmd: string,
): string {
  const maskedKeys = new Set(
    lignes
      .filter((ligne) => ligne.nature === 'M' && isInForce(ligne, dateYmd))
      .map((ligne) => mailleKey(ligne.maille)),
  )

  const candidates = lignes.filter(
    (ligne) =>
      ligne.nature === 'D' &&
      isInForce(ligne, dateYmd) &&
      coversTarget(maille, ligne.maille) &&
      !maskedKeys.has(mailleKey(ligne.maille)),
  )

  const winners = winnersByMailleKey(candidates, maille, dateYmd)
  return mostSpecific(winners, maille, dateYmd).plateforme
}
