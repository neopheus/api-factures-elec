import { describe, expect, it } from 'vitest'
import {
  type ActualisationFlux13,
  generateActualisationXml,
  ROUTAGE_SCHEME_ID_PLACEHOLDER,
} from '../../src/annuaire/flux13-xml.js'
import {
  validateAgainstAnnuaireActualisationXsd,
  validateAgainstAnnuaireConsultationXsd,
} from '../helpers/annuaire-xsd.js'

const base: ActualisationFlux13 = {
  codesRoutage: [],
  lignes: [
    {
      nature: 'D' as const,
      dateDebut: '20260901',
      dateFin: undefined,
      maille: { siren: '123456789', siret: '12345678900011' },
      plateforme: '0007',
    },
  ],
}

describe('generateActualisationXml (Annuaire_Actualisation_F12-F13.xsd)', () => {
  it('produit un XML valide contre le XSD DGFiP actualisation', () => {
    const { valid, errors } = validateAgainstAnnuaireActualisationXsd(
      generateActualisationXml(base),
    )
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })

  it('émet Nature/DateEffet/InfoAdressage imbriqué + qualifiant requis', () => {
    const xml = generateActualisationXml(base)
    expect(xml).toContain('<AnnuaireActualisation>')
    expect(xml).toContain('<BlocLignesAnnuaire>')
    expect(xml).toContain('<Nature>D</Nature>')
    expect(xml).toContain('<DateDebut>20260901</DateDebut>')
    expect(xml).toContain('qualifiant="0002"') // IdLinSIREN@qualifiant (XSD required)
    expect(xml).toContain('qualifiant="0009"') // IdLinSIRET@qualifiant (XSD required)
    expect(xml).toContain('<IdPlateforme>0007</IdPlateforme>')
  })

  it('émet les lignes de masquage AVANT les définitions (F13 row 20)', () => {
    const xml = generateActualisationXml({
      ...base,
      lignes: [
        { ...base.lignes[0]! },
        {
          nature: 'M' as const,
          dateDebut: '20260801',
          dateFin: undefined,
          maille: { siren: '123456789' },
          plateforme: '0007',
        },
      ],
    })
    expect(xml.indexOf('<Nature>M</Nature>')).toBeLessThan(
      xml.indexOf('<Nature>D</Nature>'),
    )
    expect(validateAgainstAnnuaireActualisationXsd(xml).valid).toBe(true)
  })

  it('trie M-avant-D quel que soit l’ordre d’entrée (M en tête ou en second, mix D/M)', () => {
    const xml = generateActualisationXml({
      ...base,
      lignes: [
        {
          nature: 'M' as const,
          dateDebut: '20260701',
          maille: { siren: '111111111' },
          plateforme: '0001',
        },
        {
          nature: 'D' as const,
          dateDebut: '20260801',
          maille: { siren: '222222222' },
          plateforme: '0002',
        },
        {
          nature: 'D' as const,
          dateDebut: '20260901',
          maille: { siren: '333333333' },
          plateforme: '0003',
        },
        {
          nature: 'M' as const,
          dateDebut: '20261001',
          maille: { siren: '444444444' },
          plateforme: '0004',
        },
      ],
    })
    const natures = [...xml.matchAll(/<Nature>([DM])<\/Nature>/g)].map(
      (m) => m[1],
    )
    expect(natures).toEqual(['M', 'M', 'D', 'D'])
    expect(validateAgainstAnnuaireActualisationXsd(xml).valid).toBe(true)
  })

  it('préserve un ordre relatif stable entre lignes de même Nature (tri M-avant-D)', () => {
    const xml = generateActualisationXml({
      ...base,
      lignes: [
        {
          nature: 'D' as const,
          dateDebut: '20260101',
          maille: { siren: '111111111' },
          plateforme: '0001',
        },
        {
          nature: 'D' as const,
          dateDebut: '20260201',
          maille: { siren: '222222222' },
          plateforme: '0002',
        },
      ],
    })
    expect(xml.indexOf('111111111')).toBeLessThan(xml.indexOf('222222222'))
  })

  it('échappe les caractères XML dangereux (injection-proof)', () => {
    // suffixe arbitraire porté par un tenant — jamais concaténé nu
    const xml = generateActualisationXml({
      ...base,
      lignes: [
        {
          ...base.lignes[0]!,
          maille: { siren: '123456789', suffixe: 'A & <B>' },
        },
      ],
    })
    expect(xml).toContain('A &amp; &lt;B&gt;')
    expect(xml).not.toContain('<B>')
    const { valid, errors } = validateAgainstAnnuaireActualisationXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })

  it('émet IdLinRoutage (maille SIREN_SIRET_ROUTAGE) avec qualifiant requis, distinct de 0002/0009', () => {
    const xml = generateActualisationXml({
      ...base,
      lignes: [
        {
          nature: 'D' as const,
          dateDebut: '20260901',
          dateFin: '20270101',
          maille: {
            siren: '123456789',
            siret: '12345678900011',
            routageId: 'SVC-A',
          },
          plateforme: '0007',
        },
      ],
    })
    expect(xml).toContain('<IdLinRoutage')
    expect(xml).toContain(
      `qualifiant="${ROUTAGE_SCHEME_ID_PLACEHOLDER}">SVC-A<`,
    )
    expect(xml).toContain('<DateFin>20270101</DateFin>')
    const { valid, errors } = validateAgainstAnnuaireActualisationXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
    // ANNEXE 3 (Format sémantique FE annuaire V1.8) : le qualifiant d'un
    // identifiant de routage ne peut PAS valoir 0002 (SIREN) ni 0009 (SIRET).
    expect(ROUTAGE_SCHEME_ID_PLACEHOLDER).not.toBe('0002')
    expect(ROUTAGE_SCHEME_ID_PLACEHOLDER).not.toBe('0009')
  })

  it('émet BlocCodesRoutage (Statut/IdSIRET@qualifiant/IdRoutage@qualifiant/Nom) quand fourni', () => {
    const xml = generateActualisationXml({
      codesRoutage: [
        {
          statut: 'A',
          siret: '12345678900011',
          routageId: 'SVC-A',
          nom: 'Service Achats',
        },
      ],
      lignes: [],
    })
    expect(xml).toContain('<BlocCodesRoutage>')
    expect(xml).toContain('<CodeRoutage>')
    expect(xml).toContain('<Statut>A</Statut>')
    expect(xml).toContain('<Nom>Service Achats</Nom>')
    expect(xml).not.toContain('<BlocLignesAnnuaire>')
    const { valid, errors } = validateAgainstAnnuaireActualisationXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })

  it("n'émet ni BlocCodesRoutage ni BlocLignesAnnuaire quand les deux sont vides", () => {
    const xml = generateActualisationXml({ codesRoutage: [], lignes: [] })
    expect(xml).not.toContain('BlocCodesRoutage')
    expect(xml).not.toContain('BlocLignesAnnuaire')
    const { valid, errors } = validateAgainstAnnuaireActualisationXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })

  // Sentinelle non-complacente (discipline 2.3/e-reporting) : prouve que le
  // helper de validation REJETTE effectivement une instance non conforme,
  // plutôt que de toujours retourner `valid: true`.
  it('sentinelle : le validateur XSD rejette une instance F13 à laquelle il manque IdPlateforme (requis)', () => {
    const invalid = `<?xml version="1.0" encoding="UTF-8"?>
<AnnuaireActualisation>
  <BlocLignesAnnuaire>
    <LigneAnnuaire>
      <Nature>D</Nature>
      <DateEffet>
        <DateDebut>20260901</DateDebut>
      </DateEffet>
      <InfoAdressage>
        <Identifiant>
          <IdLinSIREN qualifiant="0002">123456789</IdLinSIREN>
        </Identifiant>
      </InfoAdressage>
    </LigneAnnuaire>
  </BlocLignesAnnuaire>
</AnnuaireActualisation>`
    const { valid, errors } = validateAgainstAnnuaireActualisationXsd(invalid)
    expect(valid).toBe(false)
    expect(errors).toContain('IdPlateforme')
  })

  // Sentinelle croisée : une instance F13 valide contre le XSD Actualisation
  // ne doit PAS valider contre le XSD Consultation (racine différente,
  // Task 3 risque #1 D3) — preuve que les deux helpers ciblent des schémas
  // distincts et ne sont pas interchangeables.
  it('sentinelle : une instance F13 valide échoue contre le XSD F14 (racines distinctes)', () => {
    const xml = generateActualisationXml(base)
    expect(validateAgainstAnnuaireConsultationXsd(xml).valid).toBe(false)
  })
})
