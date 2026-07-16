import { describe, expect, it } from 'vitest'
import {
  formatParsingError,
  generateFlux6Cdar,
  validateFlux6Structure,
} from '../../src/cdv/flux6-cdar.js'

const base = {
  senderMatricule: '0000',
  invoiceRef: 'FAC-2026-0001',
  statusCode: 213,
  statusHorodate: '20260905143000',
  messageHorodate: '20260905143005',
  motif: 'Anomalie fonctionnelle détectée au contrôle',
  issuer: '123456789',
  recipient: '987654321',
}

describe('generateFlux6Cdar (Annexe 2 V2.3 « CDV FE - CI ARM », UN/CEFACT SCRDM CI)', () => {
  it('émet un CrossIndustryApplicationResponse structurellement valide', () => {
    const xml = generateFlux6Cdar(base)
    expect(xml).toContain('rsm:CrossIndustryApplicationResponse')
    expect(xml).toContain(
      '<ram:ProcessConditionCode>213</ram:ProcessConditionCode>',
    ) // MDT-105
    expect(xml).toContain(
      '<ram:IssuerAssignedID>FAC-2026-0001</ram:IssuerAssignedID>',
    ) // MDT-87
    expect(xml).toContain('20260905143000') // MDT-78 horodate statut
    expect(xml).toContain('schemeID="0002"') // ICD 6523 SIREN
    const { valid, errors } = validateFlux6Structure(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })

  it('rejette un code de statut hors Tableau 8', () => {
    expect(() => generateFlux6Cdar({ ...base, statusCode: 999 })).toThrow()
  })

  it('rejette un horodate de statut mal formé (≠ AAAAMMJJHHMMSS)', () => {
    expect(() =>
      generateFlux6Cdar({ ...base, statusHorodate: '2026-09-05' }),
    ).toThrow()
  })

  it('rejette un horodate de message mal formé (≠ AAAAMMJJHHMMSS)', () => {
    expect(() =>
      generateFlux6Cdar({ ...base, messageHorodate: '2026-09-05' }),
    ).toThrow()
  })

  it('échappe les caractères XML dangereux du motif (injection-proof)', () => {
    const xml = generateFlux6Cdar({ ...base, motif: 'A & <B>' })
    expect(xml).toContain('A &amp; &lt;B&gt;')
  })

  it('validateFlux6Structure détecte un ProcessConditionCode manquant', () => {
    expect(
      validateFlux6Structure('<rsm:CrossIndustryApplicationResponse/>').valid,
    ).toBe(false)
  })

  // Amendement A2 (contrôleur, plan-3-1-review.md, RATIFIÉ) : les parties
  // sont sous rsm:ExchangedDocument, PAS sous rsm:AcknowledgementDocument —
  // verrouillé ici pour ne jamais régresser vers le placement erroné du
  // plan initial (un générateur ET un validateur qui suivraient tous deux
  // le mauvais chemin s'accorderaient silencieusement, cf. revue §4).
  it('place les 3 parties (Sender/Issuer/RecipientTradeParty) sous rsm:ExchangedDocument, jamais sous rsm:AcknowledgementDocument', () => {
    const xml = generateFlux6Cdar(base)
    const exchangedDocumentMatch = xml.match(
      /<rsm:ExchangedDocument>([\s\S]*?)<\/rsm:ExchangedDocument>/,
    )
    const acknowledgementDocumentMatch = xml.match(
      /<rsm:AcknowledgementDocument>([\s\S]*?)<\/rsm:AcknowledgementDocument>/,
    )
    expect(exchangedDocumentMatch).not.toBeNull()
    expect(acknowledgementDocumentMatch).not.toBeNull()
    const exchangedDocumentBody = exchangedDocumentMatch![1]
    const acknowledgementDocumentBody = acknowledgementDocumentMatch![1]
    expect(exchangedDocumentBody).toContain('ram:SenderTradeParty')
    expect(exchangedDocumentBody).toContain('ram:IssuerTradeParty')
    expect(exchangedDocumentBody).toContain('ram:RecipientTradeParty')
    expect(acknowledgementDocumentBody).not.toContain('TradeParty')
  })

  it('émet MDT-74 MultipleReferencesIndicator=False en PREMIER enfant d’AcknowledgementDocument (revue T2 F-1)', () => {
    const xml = generateFlux6Cdar(base)
    const acknowledgementDocumentBody = xml.match(
      /<rsm:AcknowledgementDocument>([\s\S]*?)<\/rsm:AcknowledgementDocument>/,
    )![1]!
    // Requis 1..1 (CDAR et PPF), valeur FIXE 'False', ordre xlsx : 1er enfant.
    // (sortie prettyPrint → assertions tolérantes aux blancs)
    expect(acknowledgementDocumentBody).toMatch(
      /<ram:MultipleReferencesIndicator>\s*<udt:Indicator>False<\/udt:Indicator>\s*<\/ram:MultipleReferencesIndicator>/,
    )
    expect(
      acknowledgementDocumentBody
        .trimStart()
        .startsWith('<ram:MultipleReferencesIndicator>'),
    ).toBe(true)
  })

  it('porte @format="204" (UNTDID 2379, AAAAMMJJHHMMSS) sur les deux udt:DateTimeString (MDT-8-1/MDT-78-1)', () => {
    const xml = generateFlux6Cdar(base)
    const matches = [...xml.matchAll(/<udt:DateTimeString format="204">/g)]
    expect(matches).toHaveLength(2)
  })

  it('sender porte schemeID="0238" (matricule PDP/PPF, ICD 6523) — MDT-18', () => {
    const xml = generateFlux6Cdar(base)
    expect(xml).toContain('schemeID="0238"')
  })

  it('omet les parties émetteur/destinataire et le motif quand ils sont absents (optionnels), reste structurellement valide', () => {
    const { issuer, recipient, motif, ...required } = base
    const xml = generateFlux6Cdar(required)
    expect(xml).not.toContain('IssuerTradeParty')
    expect(xml).not.toContain('RecipientTradeParty')
    expect(xml).not.toContain('SpecifiedDocumentStatus')
    expect(xml).toContain('ram:SenderTradeParty')
    const { valid, errors } = validateFlux6Structure(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })
})

describe('validateFlux6Structure (validation structurelle — aucun XSD DGFiP F6, D3)', () => {
  it('rejette un XML non bien formé', () => {
    const { valid, errors } = validateFlux6Structure('<a b="1 2>c</a>')
    expect(valid).toBe(false)
    expect(errors).toContain('mal formé')
  })

  it('détecte un bloc rsm:ExchangedDocument absent', () => {
    const xml = generateFlux6Cdar(base).replace(
      /<rsm:ExchangedDocument>[\s\S]*?<\/rsm:ExchangedDocument>/,
      '',
    )
    const { valid, errors } = validateFlux6Structure(xml)
    expect(valid).toBe(false)
    expect(errors).toContain('rsm:ExchangedDocument absent')
  })

  it('détecte un bloc rsm:AcknowledgementDocument absent', () => {
    const xml = generateFlux6Cdar(base).replace(
      /<rsm:AcknowledgementDocument>[\s\S]*?<\/rsm:AcknowledgementDocument>/,
      '',
    )
    const { valid, errors } = validateFlux6Structure(xml)
    expect(valid).toBe(false)
    expect(errors).toContain('rsm:AcknowledgementDocument absent')
  })

  it('détecte un ram:IssuerAssignedID absent', () => {
    const xml = generateFlux6Cdar(base).replace(
      '<ram:IssuerAssignedID>FAC-2026-0001</ram:IssuerAssignedID>',
      '',
    )
    const { valid, errors } = validateFlux6Structure(xml)
    expect(valid).toBe(false)
    expect(errors).toContain('IssuerAssignedID')
  })

  it('détecte un ram:ProcessConditionCode hors Tableau 8', () => {
    const xml = generateFlux6Cdar(base).replace('>213<', '>999<')
    const { valid, errors } = validateFlux6Structure(xml)
    expect(valid).toBe(false)
    expect(errors).toContain('Tableau 8')
  })

  it('détecte une horodate MDT-8 (message) mal formée dans ExchangedDocument', () => {
    const xml = generateFlux6Cdar(base).replace('20260905143005', 'abc')
    const { valid, errors } = validateFlux6Structure(xml)
    expect(valid).toBe(false)
    expect(errors).toContain('MDT-8')
  })

  it('détecte une horodate MDT-78 (statut) mal formée dans AcknowledgementDocument', () => {
    const xml = generateFlux6Cdar(base).replace('20260905143000', 'abc')
    const { valid, errors } = validateFlux6Structure(xml)
    expect(valid).toBe(false)
    expect(errors).toContain('MDT-78')
  })

  it('détecte un @schemeID hors ICD 6523 {0002,0009,0224,0238}', () => {
    const xml = generateFlux6Cdar(base).replace(
      'schemeID="0238"',
      'schemeID="9999"',
    )
    const { valid, errors } = validateFlux6Structure(xml)
    expect(valid).toBe(false)
    expect(errors).toContain('schemeID')
  })

  it('détecte une racine rsm:CrossIndustryApplicationResponse absente (mais XML par ailleurs bien formé)', () => {
    const xml = generateFlux6Cdar(base).replaceAll(
      'rsm:CrossIndustryApplicationResponse',
      'rsm:SomethingElse',
    )
    const { valid, errors } = validateFlux6Structure(xml)
    expect(valid).toBe(false)
    expect(errors).toContain('racine')
  })

  it('détecte un ram:ProcessConditionCode totalement absent (pas seulement hors Tableau 8)', () => {
    const xml = generateFlux6Cdar(base).replace(
      '<ram:ProcessConditionCode>213</ram:ProcessConditionCode>',
      '',
    )
    const { valid, errors } = validateFlux6Structure(xml)
    expect(valid).toBe(false)
    expect(errors).toContain('ProcessConditionCode')
    expect(errors).toContain('absent')
  })

  it('accepte un golden minimal (sans parties optionnelles ni motif)', () => {
    const { issuer, recipient, motif, ...required } = base
    const xml = generateFlux6Cdar(required)
    const { valid, errors } = validateFlux6Structure(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })
})

describe('formatParsingError (précédent annuaire-xsd-validator.ts / ereporting-xsd-validator.ts)', () => {
  it('formate le message d’une Error', () => {
    expect(formatParsingError(new Error('boom'))).toBe('boom')
  })

  it('formate (String()) une cause qui n’est PAS une Error', () => {
    expect(formatParsingError('boom')).toBe('boom')
    expect(formatParsingError(42)).toBe('42')
  })
})
