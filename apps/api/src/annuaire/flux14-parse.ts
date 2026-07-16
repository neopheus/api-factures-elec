import { create } from 'xmlbuilder2'
import { validateAnnuaireConsultationXml } from './annuaire-xsd-validator.js'
import type { LigneAdressage, Maille } from './ligne-adressage.js'
import {
  NATURES,
  type Nature,
  TYPE_FLUX,
  type TypeFlux,
} from './nomenclature.js'

// Parseur XSD-validé du Flux 14 (Consultation, PPF→PA — D3/plan 2.4).
// InfoAdressageConsultationType (Annuaire_Commun.xsd) : identifiants PLATS,
// frères d'Identifiant — contrairement au F13 où ils sont imbriqués sous
// <Identifiant> (flux13-xml.ts). L'instance est SANS préfixe de namespace
// (même constat D3 que flux13-xml.ts).
//
// PII-MINIMALE (D8, plan-2-4-review.md §5) : seuls les identifiants de
// maille + plateforme + validité + nature sont extraits de
// BlocLignesAnnuaire. BlocUnitesLegales/BlocEtablissements/BlocCodesRoutage/
// BlocIdPlateformesReception (qui portent Nom/Adresse/Diffusible/Contact —
// PII) ne sont JAMAIS lus : ils ne sont même pas typés ci-dessous, donc
// structurellement absents du résultat (pas seulement omis par convention).

export class InvalidConsultationF14XmlError extends Error {
  constructor(readonly xsdErrors: string) {
    super(`flux F14 XSD-invalide — rejeté avant tout parsing :\n${xsdErrors}`)
    this.name = 'InvalidConsultationF14XmlError'
  }
}

// A-MIRROR-KEY (plan-2-4-review.md §3) : le XSD F14 type `Nature` en
// `xs:string` NON restreint (Annuaire_Commun.xsd l.216) — une valeur hors
// {D,M} validerait le XSD mais ferait échouer l'upsert du miroir (colonne
// enum `annuaireNature`). Rejet typé ICI, avant que la valeur n'atteigne
// quelque colonne enum que ce soit.
export class UnknownLigneNatureError extends Error {
  constructor(
    readonly rawValue: string,
    readonly ligneIndex: number,
  ) {
    super(
      `Nature "${rawValue}" (LigneAnnuaire #${ligneIndex}) hors nomenclature {D,M} — XSD xs:string non restrictif, rejet applicatif requis (A-MIRROR-KEY)`,
    )
    this.name = 'UnknownLigneNatureError'
  }
}

// Task 9 (injection revue T3, INFO) : TypeFlux racine est lui aussi
// xs:string NON restreint côté XSD (Annuaire_Consultation_F14.xsd) — même
// motif qu'UnknownLigneNatureError ci-dessus (A-MIRROR-KEY), une valeur hors
// {C,D} validerait le XSD mais ne correspondrait à aucun `TypeFlux` de
// nomenclature.ts consommé par l'ingestion (Task 9, choix upsert vs
// remplacement complet).
export class UnknownTypeFluxError extends Error {
  constructor(readonly rawValue: string) {
    super(
      `TypeFlux "${rawValue}" hors nomenclature {C,D} — XSD xs:string non restrictif, rejet applicatif requis`,
    )
    this.name = 'UnknownTypeFluxError'
  }
}

export interface ConsultationF14 {
  typeFlux: TypeFlux
  horodate: string
  lignes: LigneAdressage[]
}

// xmlbuilder2 `end({ format: 'object' })` réutilise en interne le même
// sérialiseur texte que l'écrivain XML (BaseWriter._serializeText) : chaque
// nœud texte est RE-échappé (`&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`) AVANT
// d'être placé dans l'objet JS — alors que le lecteur XML avait déjà
// correctement DÉCODÉ ces entités (et toute entité numérique `&#NN;`/
// `&#xHH;`) au moment du parsing. Net effet observé (vérifié empiriquement,
// Task 3, node -e sur xmlbuilder2@4.0.3) : SEULS `&`/`<`/`>` ressortent
// ré-échappés en entités NOMMÉES dans l'objet ; les guillemets et les
// entités numériques sont décodés correctement dès la lecture et ne sont
// JAMAIS ré-corrompus (BaseWriter._serializeText ne remplace que &/</>).
// Décoder plus large (quot/apos/numériques) ajouterait du code mort et
// invérifiable par ce pipeline précis — on décode donc EXACTEMENT les 3
// entités effectivement corrompues, sous peine sinon de stocker/comparer
// des mailles altérées (ex: un Suffixe "A & <B>" reviendrait
// "A &amp; &lt;B&gt;").
function decodeXmlEntities(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (_match, tag: string) => {
    if (tag === 'amp') return '&'
    if (tag === 'lt') return '<'
    return '>' // tag === 'gt' — seule possibilité restante (regex l'exige)
  })
}

// Élément avec attribut (IdLinSIREN/IdLinSIRET/IdLinRoutage) : les 3 types
// XSD sous-jacents (IdSirenType/IdSiretType/IdCodesRoutageType,
// Annuaire_Commun.xsd) portent TOUS un attribut `qualifiant` `use="required"`
// — xmlbuilder2 renvoie donc TOUJOURS `{ '@qualifiant': ..., '#': texte }`
// pour ces 3 éléments (jamais un plain string : structurellement exclu par
// le XSD déjà validé en amont), d'où un type d'entrée resserré (pas
// d'union avec `string`, qui serait un cas mort ici).
interface RawIdLin {
  '@qualifiant': string
  '#': string
}

function textOf(node: RawIdLin): string {
  return decodeXmlEntities(node['#'])
}

interface RawDateEffet {
  DateDebut: string
  DateFin?: string
  DateFinEffective?: string
}

interface RawInfoAdressage {
  // Identifiant plat (F14) : clé composite lisible, redondante avec les
  // champs frères ci-dessous — jamais consommée (PII-minimale, on
  // reconstruit la maille depuis IdLinSIREN/IdLinSIRET/IdLinRoutage/Suffixe).
  Identifiant: string
  IdLinSIREN: RawIdLin
  IdLinSIRET?: RawIdLin
  IdLinRoutage?: RawIdLin
  Suffixe?: string
}

interface RawLigneAnnuaire {
  IdInstance: string
  MotifPresence: string
  Nature: string
  DateEffet: RawDateEffet
  InfoAdressage: RawInfoAdressage
  IdPlateforme: string
}

interface RawAnnuaireConsultationF14 {
  HorodateProduction: string
  DernierHorodateProduction?: string
  TypeFlux: string
  BlocLignesAnnuaire?: {
    LigneAnnuaire: RawLigneAnnuaire | RawLigneAnnuaire[]
  }
}

interface RawRoot {
  AnnuaireConsultationF14: RawAnnuaireConsultationF14
}

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value]
}

function toLigneAdressage(
  raw: RawLigneAnnuaire,
  index: number,
): LigneAdressage {
  const rawNature = decodeXmlEntities(raw.Nature)
  if (!(NATURES as readonly string[]).includes(rawNature)) {
    throw new UnknownLigneNatureError(rawNature, index)
  }
  const nature = rawNature as Nature

  const info = raw.InfoAdressage
  const maille: Maille = {
    siren: textOf(info.IdLinSIREN),
    ...(info.IdLinSIRET !== undefined
      ? { siret: textOf(info.IdLinSIRET) }
      : {}),
    ...(info.IdLinRoutage !== undefined
      ? { routageId: textOf(info.IdLinRoutage) }
      : {}),
    ...(info.Suffixe !== undefined
      ? { suffixe: decodeXmlEntities(info.Suffixe) }
      : {}),
  }

  return {
    maille,
    nature,
    dateDebut: raw.DateEffet.DateDebut,
    ...(raw.DateEffet.DateFin !== undefined
      ? { dateFin: raw.DateEffet.DateFin }
      : {}),
    // DateFinEffective (Task 9, injection revue T3) : DateType (\d{8}), pas
    // d'entités XML possibles — même absence de decodeXmlEntities que
    // DateDebut/DateFin ci-dessus (cohérence, pas un oubli).
    ...(raw.DateEffet.DateFinEffective !== undefined
      ? { dateFinEffective: raw.DateEffet.DateFinEffective }
      : {}),
    plateforme: decodeXmlEntities(raw.IdPlateforme),
  }
}

// Valide le F14 contre le XSD DGFiP AVANT tout parsing (rejette un flux
// invalide plutôt que de tenter de le désérialiser partiellement), puis
// désérialise BlocLignesAnnuaire.LigneAnnuaire[] en LigneAdressage[] (Task 2)
// — cardinalité 1 vs n normalisée (xmlbuilder2 renvoie un objet scalaire
// pour 1 occurrence, un tableau pour n). Un F14 « vide » (HorodateProduction
// + TypeFlux seuls, BlocLignesAnnuaire absent) est XSD-valide (D3, vérifié
// xmllint) et produit `lignes: []`, pas une erreur.
export async function parseConsultationF14(
  xml: string,
): Promise<ConsultationF14> {
  const { valid, errors } = await validateAnnuaireConsultationXml(xml)
  if (!valid) throw new InvalidConsultationF14XmlError(errors)

  const parsed = create(xml).end({ format: 'object' }) as unknown as RawRoot
  const root = parsed.AnnuaireConsultationF14

  const rawTypeFlux = decodeXmlEntities(root.TypeFlux)
  if (!(TYPE_FLUX as readonly string[]).includes(rawTypeFlux)) {
    throw new UnknownTypeFluxError(rawTypeFlux)
  }

  const lignes = root.BlocLignesAnnuaire
    ? asArray(root.BlocLignesAnnuaire.LigneAnnuaire).map(toLigneAdressage)
    : []

  return {
    typeFlux: rawTypeFlux as TypeFlux,
    horodate: decodeXmlEntities(root.HorodateProduction),
    lignes,
  }
}
