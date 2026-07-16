import { describe, expect, it } from 'vitest'
import {
  AmbiguousResolutionError,
  isInForce,
  type LigneAdressage,
  mailleKey,
  overlaps,
  RecipientUnaddressableError,
  resolveRecipient,
} from '../../src/annuaire/ligne-adressage.js'

const siren = '123456789'
const siret = '1'.repeat(14)
const autreSiret = '2'.repeat(14)

const ligne = (over: Partial<LigneAdressage>): LigneAdressage => ({
  maille: { siren },
  nature: 'D',
  dateDebut: '20260101',
  dateFin: undefined,
  plateforme: '0007',
  ...over,
})

describe('validité semi-ouverte [DateDebut, DateFin) (D4, ANNEXE 3 F13 rows 23-24)', () => {
  it('inclut la date de début, exclut la date de fin', () => {
    const l = ligne({ dateDebut: '20260901', dateFin: '20260910' })
    expect(isInForce(l, '20260901')).toBe(true) // début inclus
    expect(isInForce(l, '20260909')).toBe(true)
    expect(isInForce(l, '20260910')).toBe(false) // fin EXCLUE (J=DateFin)
    expect(isInForce(l, '20260831')).toBe(false)
  })
  it('sans DateFin : en vigueur indéfiniment à partir du début', () => {
    expect(isInForce(ligne({ dateDebut: '20260101' }), '20991231')).toBe(true)
  })
})

describe('chevauchement de mailles identiques', () => {
  it('détecte deux définitions qui se recouvrent', () => {
    const a = ligne({ dateDebut: '20260101', dateFin: '20260201' })
    const b = ligne({ dateDebut: '20260115', dateFin: '20260301' })
    expect(overlaps(a, b)).toBe(true)
  })
  it('des périodes jointives ne se chevauchent pas (semi-ouvert)', () => {
    const a = ligne({ dateDebut: '20260101', dateFin: '20260201' })
    const b = ligne({ dateDebut: '20260201', dateFin: '20260301' })
    expect(overlaps(a, b)).toBe(false)
  })
  it('des mailles différentes ne se chevauchent jamais, même sur les mêmes dates', () => {
    const a = ligne({
      maille: { siren },
      dateDebut: '20260101',
      dateFin: '20260201',
    })
    const b = ligne({
      maille: { siren, siret },
      dateDebut: '20260101',
      dateFin: '20260201',
    })
    expect(overlaps(a, b)).toBe(false)
  })
  it('une ligne sans DateFin (ouverte) chevauche toute période postérieure à son début', () => {
    const a = ligne({ dateDebut: '20260101', dateFin: undefined })
    const b = ligne({ dateDebut: '20300101', dateFin: '20300201' })
    expect(overlaps(a, b)).toBe(true)
  })
  it('une ligne ouverte ne chevauche pas une période entièrement antérieure à son début', () => {
    const a = ligne({ dateDebut: '20260101', dateFin: undefined })
    const b = ligne({ dateDebut: '20250101', dateFin: '20250201' })
    expect(overlaps(a, b)).toBe(false)
  })
  it('une période close chevauche une seconde ligne ouverte (sans DateFin) démarrant dedans', () => {
    const a = ligne({ dateDebut: '20260101', dateFin: '20260201' })
    const b = ligne({ dateDebut: '20260115', dateFin: undefined })
    expect(overlaps(a, b)).toBe(true)
  })
  it('deux lignes ouvertes (sans DateFin) se chevauchent toujours dès lors que l’une a commencé', () => {
    const a = ligne({ dateDebut: '20260101', dateFin: undefined })
    const b = ligne({ dateDebut: '20260601', dateFin: undefined })
    expect(overlaps(a, b)).toBe(true)
  })
})

describe('mailleKey', () => {
  it('produit la même clé pour deux mailles identiques', () => {
    expect(mailleKey({ siren, siret })).toBe(mailleKey({ siren, siret }))
  })
  it('distingue deux mailles différentes', () => {
    expect(mailleKey({ siren })).not.toBe(mailleKey({ siren, siret }))
    expect(mailleKey({ siren, siret })).not.toBe(
      mailleKey({ siren, siret: autreSiret }),
    )
  })
})

describe('résolution du routage (maille la plus spécifique en vigueur)', () => {
  it('préfère SIREN_SIRET à SIREN', () => {
    const lignes = [
      ligne({ maille: { siren }, plateforme: '0001' }),
      ligne({ maille: { siren, siret }, plateforme: '0002' }),
    ]
    expect(resolveRecipient(lignes, { siren, siret }, '20260601')).toBe('0002')
  })

  it('préfère SIREN_SIRET_ROUTAGE à SIREN_SIRET', () => {
    const lignes = [
      ligne({ maille: { siren, siret }, plateforme: '0001' }),
      ligne({
        maille: { siren, siret, routageId: 'SVC' },
        plateforme: '0002',
      }),
    ]
    expect(
      resolveRecipient(lignes, { siren, siret, routageId: 'SVC' }, '20260601'),
    ).toBe('0002')
  })

  it('préfère SIREN_SUFFIXE à SIREN', () => {
    const lignes = [
      ligne({ maille: { siren }, plateforme: '0001' }),
      ligne({ maille: { siren, suffixe: 'DEPT-X' }, plateforme: '0002' }),
    ]
    expect(
      resolveRecipient(lignes, { siren, suffixe: 'DEPT-X' }, '20260601'),
    ).toBe('0002')
  })

  it('ignore une ligne masquée (Nature=M) et lève si non adressable', () => {
    const lignes = [ligne({ nature: 'M', dateDebut: '20260101' })]
    expect(() => resolveRecipient(lignes, { siren }, '20260601')).toThrow(
      RecipientUnaddressableError,
    )
  })

  it('lève RecipientUnaddressableError si la liste de lignes est vide', () => {
    expect(() => resolveRecipient([], { siren }, '20260601')).toThrow(
      RecipientUnaddressableError,
    )
  })

  it('ignore une ligne d’un autre SIREN', () => {
    const lignes = [
      ligne({ maille: { siren: '999999999' }, plateforme: '0009' }),
    ]
    expect(() => resolveRecipient(lignes, { siren }, '20260601')).toThrow(
      RecipientUnaddressableError,
    )
  })

  it('ignore une ligne SIREN_SIRET pour un SIRET différent', () => {
    const lignes = [
      ligne({ maille: { siren, siret: autreSiret }, plateforme: '0009' }),
    ]
    expect(() =>
      resolveRecipient(lignes, { siren, siret }, '20260601'),
    ).toThrow(RecipientUnaddressableError)
  })

  it('ignore une ligne de routage pour un identifiant de routage différent (même SIRET)', () => {
    const lignes = [
      ligne({
        maille: { siren, siret, routageId: 'AUTRE' },
        plateforme: '0009',
      }),
    ]
    expect(() =>
      resolveRecipient(lignes, { siren, siret, routageId: 'SVC' }, '20260601'),
    ).toThrow(RecipientUnaddressableError)
  })

  it('ignore une ligne de routage pour un SIRET différent (même identifiant de routage)', () => {
    const lignes = [
      ligne({
        maille: { siren, siret: autreSiret, routageId: 'SVC' },
        plateforme: '0009',
      }),
    ]
    expect(() =>
      resolveRecipient(lignes, { siren, siret, routageId: 'SVC' }, '20260601'),
    ).toThrow(RecipientUnaddressableError)
  })

  it('ignore une ligne de suffixe différent', () => {
    const lignes = [
      ligne({ maille: { siren, suffixe: 'AUTRE' }, plateforme: '0009' }),
    ]
    expect(() =>
      resolveRecipient(lignes, { siren, suffixe: 'DEPT-X' }, '20260601'),
    ).toThrow(RecipientUnaddressableError)
  })

  it('ignore une définition hors de sa période de validité à la date de résolution', () => {
    const lignes = [
      ligne({ maille: { siren }, dateDebut: '20270101', plateforme: '0009' }),
    ]
    expect(() => resolveRecipient(lignes, { siren }, '20260601')).toThrow(
      RecipientUnaddressableError,
    )
  })
})

describe('résolution : départage de Définitions concurrentes sur la même maille (A-RESOLVE-EDGES #1, INTERPRÉTATION)', () => {
  it('la Définition la plus récente (DateDebut max) l’emporte entre deux D en vigueur', () => {
    const lignes = [
      ligne({ maille: { siren }, dateDebut: '20260101', plateforme: '0001' }),
      ligne({ maille: { siren }, dateDebut: '20260601', plateforme: '0002' }),
    ]
    expect(resolveRecipient(lignes, { siren }, '20260901')).toBe('0002')
  })

  it('lève AmbiguousResolutionError si deux D de même maille partagent exactement la même DateDebut', () => {
    const lignes = [
      ligne({ maille: { siren }, dateDebut: '20260101', plateforme: '0001' }),
      ligne({ maille: { siren }, dateDebut: '20260101', plateforme: '0002' }),
    ]
    expect(() => resolveRecipient(lignes, { siren }, '20260601')).toThrow(
      AmbiguousResolutionError,
    )
  })
})

describe('résolution : masquage-repli sur une définition moins spécifique (A-RESOLVE-EDGES #2, INTERPRÉTATION)', () => {
  it('un masquage SIREN_SIRET retombe sur une Définition SIREN restée en vigueur', () => {
    const lignes = [
      ligne({ maille: { siren }, dateDebut: '20260101', plateforme: '0001' }),
      ligne({
        maille: { siren, siret },
        dateDebut: '20260101',
        plateforme: '0002',
      }),
      ligne({
        maille: { siren, siret },
        nature: 'M',
        dateDebut: '20260301',
      }),
    ]
    expect(resolveRecipient(lignes, { siren, siret }, '20260601')).toBe('0001')
  })

  it('un masquage sans définition de repli lève RecipientUnaddressableError', () => {
    const lignes = [
      ligne({
        maille: { siren, siret },
        dateDebut: '20260101',
        plateforme: '0002',
      }),
      ligne({
        maille: { siren, siret },
        nature: 'M',
        dateDebut: '20260301',
      }),
    ]
    expect(() =>
      resolveRecipient(lignes, { siren, siret }, '20260601'),
    ).toThrow(RecipientUnaddressableError)
  })

  it('un masquage futur (pas encore en vigueur) ne masque pas encore la Définition', () => {
    const lignes = [
      ligne({
        maille: { siren, siret },
        dateDebut: '20260101',
        plateforme: '0002',
      }),
      ligne({
        maille: { siren, siret },
        nature: 'M',
        dateDebut: '20270101',
      }),
    ]
    expect(resolveRecipient(lignes, { siren, siret }, '20260601')).toBe('0002')
  })
})

describe('résolution : égalité de rang inter-maille (routage vs suffixe, A-RESOLVE-EDGES, INTERPRÉTATION)', () => {
  it('lève AmbiguousResolutionError si une ligne ROUTAGE et une ligne SUFFIXE matchent la cible au même rang', () => {
    const lignes = [
      ligne({
        maille: { siren, siret, routageId: 'SVC' },
        plateforme: '0001',
      }),
      ligne({ maille: { siren, suffixe: 'DEPT-X' }, plateforme: '0002' }),
    ]
    expect(() =>
      resolveRecipient(
        lignes,
        { siren, siret, routageId: 'SVC', suffixe: 'DEPT-X' },
        '20260601',
      ),
    ).toThrow(AmbiguousResolutionError)
  })
})
