import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  InvalidConsultationF14XmlError,
  parseConsultationF14,
  UnknownLigneNatureError,
  UnknownTypeFluxError,
} from '../../src/annuaire/flux14-parse.js'
import { validateAgainstAnnuaireConsultationXsd } from '../helpers/annuaire-xsd.js'

const FIXTURE_PATH = resolve(
  import.meta.dirname,
  '../fixtures/annuaire-f14-minimal.xml',
)
const minimalFixture = readFileSync(FIXTURE_PATH, 'utf8')

// F14 avec HorodateProduction+TypeFlux seuls, aucun bloc — cas « flux vide »
// confirmé XSD-valide par la revue D3 (plan-2-4-review.md §1).
const emptyF14 = `<?xml version="1.0" encoding="UTF-8"?>
<AnnuaireConsultationF14>
  <HorodateProduction>20260910120000</HorodateProduction>
  <TypeFlux>C</TypeFlux>
</AnnuaireConsultationF14>`

// Matricule à 3 chiffres (pattern XSD [0-9]{4}) — XSD-invalide.
const invalidF14 = `<?xml version="1.0" encoding="UTF-8"?>
<AnnuaireConsultationF14>
  <HorodateProduction>20260910120000</HorodateProduction>
  <TypeFlux>D</TypeFlux>
  <BlocLignesAnnuaire>
    <LigneAnnuaire>
      <IdInstance>1</IdInstance>
      <MotifPresence>C</MotifPresence>
      <Nature>D</Nature>
      <DateEffet>
        <DateDebut>20260901</DateDebut>
      </DateEffet>
      <InfoAdressage>
        <Identifiant>123456789</Identifiant>
        <IdLinSIREN qualifiant="0002">123456789</IdLinSIREN>
      </InfoAdressage>
      <IdPlateforme>007</IdPlateforme>
    </LigneAnnuaire>
  </BlocLignesAnnuaire>
</AnnuaireConsultationF14>`

// Nature = "X" : xs:string non restreint côté XSD (Commun l.216) — XSD-valide
// mais hors {D,M} — A-MIRROR-KEY (plan-2-4-review.md §3) exige un rejet typé
// applicatif, PAS une simple validation XSD (qui laisse passer).
const unknownNatureF14 = `<?xml version="1.0" encoding="UTF-8"?>
<AnnuaireConsultationF14>
  <HorodateProduction>20260910120000</HorodateProduction>
  <TypeFlux>D</TypeFlux>
  <BlocLignesAnnuaire>
    <LigneAnnuaire>
      <IdInstance>1</IdInstance>
      <MotifPresence>C</MotifPresence>
      <Nature>X</Nature>
      <DateEffet>
        <DateDebut>20260901</DateDebut>
      </DateEffet>
      <InfoAdressage>
        <Identifiant>123456789</Identifiant>
        <IdLinSIREN qualifiant="0002">123456789</IdLinSIREN>
      </InfoAdressage>
      <IdPlateforme>0007</IdPlateforme>
    </LigneAnnuaire>
  </BlocLignesAnnuaire>
</AnnuaireConsultationF14>`

// 2 lignes : IdLinSIRET/IdLinRoutage/Suffixe (flat F14 vs F13 imbriqué),
// Nature 'D' et 'M', caractères XML dangereux dans Suffixe/Identifiant — prouve
// à la fois la coercition Nature et le round-trip de décodage d'entités
// (xmlbuilder2 `end({format:'object'})` ré-échappe le texte lu — cf. rapport).
const multiLigneF14 = `<?xml version="1.0" encoding="UTF-8"?>
<AnnuaireConsultationF14>
  <HorodateProduction>20260910120000</HorodateProduction>
  <TypeFlux>C</TypeFlux>
  <BlocLignesAnnuaire>
    <LigneAnnuaire>
      <IdInstance>1</IdInstance>
      <MotifPresence>C</MotifPresence>
      <Nature>D</Nature>
      <DateEffet>
        <DateDebut>20260901</DateDebut>
        <DateFin>20270101</DateFin>
      </DateEffet>
      <InfoAdressage>
        <Identifiant>123456789</Identifiant>
        <IdLinSIREN qualifiant="0002">123456789</IdLinSIREN>
        <IdLinSIRET qualifiant="0009">12345678900011</IdLinSIRET>
        <IdLinRoutage qualifiant="9999">SVC-A</IdLinRoutage>
      </InfoAdressage>
      <IdPlateforme>0007</IdPlateforme>
    </LigneAnnuaire>
    <LigneAnnuaire>
      <IdInstance>2</IdInstance>
      <MotifPresence>C</MotifPresence>
      <Nature>M</Nature>
      <DateEffet>
        <DateDebut>20260801</DateDebut>
      </DateEffet>
      <InfoAdressage>
        <Identifiant>123456789_A &amp; &lt;B&gt;</Identifiant>
        <IdLinSIREN qualifiant="0002">123456789</IdLinSIREN>
        <Suffixe>A &amp; &lt;B&gt;</Suffixe>
      </InfoAdressage>
      <IdPlateforme>9998</IdPlateforme>
    </LigneAnnuaire>
  </BlocLignesAnnuaire>
</AnnuaireConsultationF14>`

// Preuve PII-minimale (D8) : la fixture PORTE des blocs Nom/Adresse
// (BlocUnitesLegales/BlocEtablissements, XSD-valides) mais parseConsultationF14
// ne doit RIEN en extraire — le résultat ne doit contenir ni le nom ni
// l'adresse, même en substring, prouvant que le parseur les laisse tomber
// plutôt que de simplement omettre un champ typé (test comportemental, pas
// seulement une assertion de type).
const piiBearingF14 = `<?xml version="1.0" encoding="UTF-8"?>
<AnnuaireConsultationF14>
  <HorodateProduction>20260910120000</HorodateProduction>
  <TypeFlux>C</TypeFlux>
  <BlocUnitesLegales>
    <UniteLegale>
      <IdInstance>1</IdInstance>
      <MotifPresence>C</MotifPresence>
      <Statut>A</Statut>
      <IdSIREN qualifiant="0002">123456789</IdSIREN>
      <Nom>Real Secret SARL</Nom>
      <TypeEntite>PM</TypeEntite>
      <Diffusible>O</Diffusible>
    </UniteLegale>
  </BlocUnitesLegales>
  <BlocEtablissements>
    <Etablissement>
      <IdInstance>1</IdInstance>
      <MotifPresence>C</MotifPresence>
      <Statut>A</Statut>
      <IdSIRET qualifiant="0009">12345678900011</IdSIRET>
      <TypeEtablissement>ETB</TypeEtablissement>
      <Nom>Real Secret SARL Etablissement</Nom>
      <LigneAdresse1>42 Rue Secrete</LigneAdresse1>
      <Diffusible>O</Diffusible>
    </Etablissement>
  </BlocEtablissements>
  <BlocLignesAnnuaire>
    <LigneAnnuaire>
      <IdInstance>1</IdInstance>
      <MotifPresence>C</MotifPresence>
      <Nature>D</Nature>
      <DateEffet>
        <DateDebut>20260901</DateDebut>
      </DateEffet>
      <InfoAdressage>
        <Identifiant>123456789</Identifiant>
        <IdLinSIREN qualifiant="0002">123456789</IdLinSIREN>
      </InfoAdressage>
      <IdPlateforme>0007</IdPlateforme>
    </LigneAnnuaire>
  </BlocLignesAnnuaire>
</AnnuaireConsultationF14>`

// Task 9 (injection revue T3, MED) : DateFinEffective (DT-7-3-3,
// PeriodeEffetConsultationType — DateDebut, DateFin?, DateFinEffective?)
// doit être porté par le parseur jusqu'au modèle LigneAdressage, additif
// (ne remplace pas dateFin ici — c'est l'ingestion, Task 9, qui calcule la
// fin EFFECTIVE min(dateFin, dateFinEffective)).
const dateFinEffectiveF14 = `<?xml version="1.0" encoding="UTF-8"?>
<AnnuaireConsultationF14>
  <HorodateProduction>20260910120000</HorodateProduction>
  <TypeFlux>D</TypeFlux>
  <BlocLignesAnnuaire>
    <LigneAnnuaire>
      <IdInstance>1</IdInstance>
      <MotifPresence>S</MotifPresence>
      <Nature>D</Nature>
      <DateEffet>
        <DateDebut>20260101</DateDebut>
        <DateFin>20270101</DateFin>
        <DateFinEffective>20260601</DateFinEffective>
      </DateEffet>
      <InfoAdressage>
        <Identifiant>123456789</Identifiant>
        <IdLinSIREN qualifiant="0002">123456789</IdLinSIREN>
      </InfoAdressage>
      <IdPlateforme>0007</IdPlateforme>
    </LigneAnnuaire>
  </BlocLignesAnnuaire>
</AnnuaireConsultationF14>`

// Task 9 (injection revue T3, INFO) : TypeFlux racine est lui aussi
// xs:string non restreint (Annuaire_Consultation_F14.xsd) — même
// discipline de coercition applicative que Nature (A-MIRROR-KEY).
const unknownTypeFluxF14 = `<?xml version="1.0" encoding="UTF-8"?>
<AnnuaireConsultationF14>
  <HorodateProduction>20260910120000</HorodateProduction>
  <TypeFlux>X</TypeFlux>
</AnnuaireConsultationF14>`

describe('parseConsultationF14 (Annuaire_Consultation_F14.xsd)', () => {
  it('A-FIXTURE : la fixture hand-authored est elle-même XSD-valide avant tout usage', () => {
    const { valid, errors } =
      validateAgainstAnnuaireConsultationXsd(minimalFixture)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })

  it('parse une instance F14 valide à 1 LigneAnnuaire (InfoAdressage PLAT)', async () => {
    const result = await parseConsultationF14(minimalFixture)
    expect(result).toEqual({
      typeFlux: 'D',
      horodate: '20260910120000',
      lignes: [
        {
          maille: { siren: '123456789' },
          nature: 'D',
          dateDebut: '20260901',
          plateforme: '0007',
        },
      ],
    })
  })

  it('parse un F14 vide (HorodateProduction+TypeFlux seuls) → lignes: []', async () => {
    const { valid } = validateAgainstAnnuaireConsultationXsd(emptyF14)
    expect(valid).toBe(true)
    const result = await parseConsultationF14(emptyF14)
    expect(result).toEqual({
      typeFlux: 'C',
      horodate: '20260910120000',
      lignes: [],
    })
  })

  it('rejette un F14 XSD-invalide (matricule à 3 chiffres) — validation XSD avant parse', async () => {
    const { valid } = validateAgainstAnnuaireConsultationXsd(invalidF14)
    expect(valid).toBe(false)
    await expect(parseConsultationF14(invalidF14)).rejects.toBeInstanceOf(
      InvalidConsultationF14XmlError,
    )
  })

  it('coerce Nature (xs:string) vers {D,M} et rejette toute autre valeur (A-MIRROR-KEY)', async () => {
    // Le XSD à lui seul laisse passer Nature="X" (xs:string non restreint) :
    // ce test prouve que c'est parseConsultationF14, pas le XSD, qui rejette.
    const { valid } = validateAgainstAnnuaireConsultationXsd(unknownNatureF14)
    expect(valid).toBe(true)
    await expect(parseConsultationF14(unknownNatureF14)).rejects.toBeInstanceOf(
      UnknownLigneNatureError,
    )
  })

  it('désérialise plusieurs lignes en LigneAdressage[] (IdLinSIRET/IdLinRoutage/Suffixe FLATS, D et M)', async () => {
    const { valid, errors } =
      validateAgainstAnnuaireConsultationXsd(multiLigneF14)
    expect(errors).toBe('')
    expect(valid).toBe(true)
    const result = await parseConsultationF14(multiLigneF14)
    expect(result.typeFlux).toBe('C')
    expect(result.lignes).toEqual([
      {
        maille: {
          siren: '123456789',
          siret: '12345678900011',
          routageId: 'SVC-A',
        },
        nature: 'D',
        dateDebut: '20260901',
        dateFin: '20270101',
        plateforme: '0007',
      },
      {
        maille: { siren: '123456789', suffixe: 'A & <B>' },
        nature: 'M',
        dateDebut: '20260801',
        plateforme: '9998',
      },
    ])
  })

  it('porte DateFinEffective jusqu’à LigneAdressage quand présente (injection revue T3)', async () => {
    const { valid, errors } =
      validateAgainstAnnuaireConsultationXsd(dateFinEffectiveF14)
    expect(errors).toBe('')
    expect(valid).toBe(true)
    const result = await parseConsultationF14(dateFinEffectiveF14)
    expect(result.lignes).toEqual([
      {
        maille: { siren: '123456789' },
        nature: 'D',
        dateDebut: '20260101',
        dateFin: '20270101',
        dateFinEffective: '20260601',
        plateforme: '0007',
      },
    ])
  })

  it('coerce TypeFlux (xs:string) vers {C,D} et rejette toute autre valeur (injection revue T3)', async () => {
    const { valid } = validateAgainstAnnuaireConsultationXsd(unknownTypeFluxF14)
    expect(valid).toBe(true)
    await expect(
      parseConsultationF14(unknownTypeFluxF14),
    ).rejects.toBeInstanceOf(UnknownTypeFluxError)
  })

  it('PII-drop (D8) : aucune trace du Nom/Adresse porté par BlocUnitesLegales/BlocEtablissements', async () => {
    const { valid, errors } =
      validateAgainstAnnuaireConsultationXsd(piiBearingF14)
    expect(errors).toBe('')
    expect(valid).toBe(true)
    const result = await parseConsultationF14(piiBearingF14)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('Real Secret SARL')
    expect(serialized).not.toContain('Rue Secrete')
    expect(result).toEqual({
      typeFlux: 'C',
      horodate: '20260910120000',
      lignes: [
        {
          maille: { siren: '123456789' },
          nature: 'D',
          dateDebut: '20260901',
          plateforme: '0007',
        },
      ],
    })
  })
})
