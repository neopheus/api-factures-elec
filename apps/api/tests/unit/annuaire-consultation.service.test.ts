import { describe, expect, it } from 'vitest'
import type { DirectoryEntrySummary } from '../../src/annuaire/annuaire.repository.js'
import { AnnuaireConsultationService } from '../../src/annuaire/annuaire-consultation.service.js'
import {
  AmbiguousResolutionError,
  RecipientUnaddressableError,
} from '../../src/annuaire/ligne-adressage.js'

// Consultation + résolution de routage (Task 7, plan 2.4) — tests unitaires
// de la couche service (stub repository, aucune base réelle). Complète
// annuaire-consultation.e2e.test.ts (bout-en-bout HTTP+DB) : ici on pin, au
// niveau de CETTE couche de consommation de `resolveRecipient` (Task 2),
// deux propriétés injectées par la revue (BINDING, message de tâche) :
// (1) l'ORDRE des entrées renvoyées par le repository n'influence jamais le
// résultat ; (2) un Masquage à une maille plus LARGE ne masque PAS une
// Définition à une maille plus SPÉCIFIQUE (non-cascade).

let nextId = 0
function entry(
  overrides: Partial<DirectoryEntrySummary> &
    Pick<
      DirectoryEntrySummary,
      'siren' | 'nature' | 'dateDebut' | 'plateforme'
    >,
): DirectoryEntrySummary {
  nextId += 1
  return {
    id: `entry-${nextId}`,
    idInstance: null,
    siret: null,
    routageId: null,
    suffixe: null,
    dateFin: null,
    sourceHorodate: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function fakeRepo(entries: DirectoryEntrySummary[]) {
  return {
    findDirectoryEntries: async (_tenantId: string, siren: string) =>
      entries.filter((e) => e.siren === siren),
  }
}

const TENANT = 'tenant-1'
const SIREN = '900000001'
const SIRET = '90000000100011'

describe('AnnuaireConsultationService.resolveRecipient — ordre-indépendance (consumption layer)', () => {
  it('résout la même plateforme quelle que soit l’ordre des entrées du miroir', async () => {
    const general = entry({
      siren: SIREN,
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0001',
    })
    const specific = entry({
      siren: SIREN,
      siret: SIRET,
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0002',
    })

    const forward = new AnnuaireConsultationService(
      fakeRepo([general, specific]) as never,
    )
    const reversed = new AnnuaireConsultationService(
      fakeRepo([specific, general]) as never,
    )

    const target = { siren: SIREN, siret: SIRET }
    const [a, b] = await Promise.all([
      forward.resolveRecipient(TENANT, target, '20260615'),
      reversed.resolveRecipient(TENANT, target, '20260615'),
    ])
    expect(a).toEqual({ plateforme: '0002' })
    expect(b).toEqual({ plateforme: '0002' })
  })

  it('reste ordre-indépendant avec 3 Définitions concurrentes de la même maille (DateDebut la + récente gagne, quel que soit l’ordre)', async () => {
    const e1 = entry({
      siren: SIREN,
      nature: 'D',
      dateDebut: '20250101',
      plateforme: '0010',
    })
    const e2 = entry({
      siren: SIREN,
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0020',
    })
    const e3 = entry({
      siren: SIREN,
      nature: 'D',
      dateDebut: '20240101',
      plateforme: '0005',
    })
    const orderings = [
      [e1, e2, e3],
      [e3, e2, e1],
      [e2, e1, e3],
    ]
    const results = await Promise.all(
      orderings.map((entries) =>
        new AnnuaireConsultationService(
          fakeRepo(entries) as never,
        ).resolveRecipient(TENANT, { siren: SIREN }, '20260615'),
      ),
    )
    expect(results).toEqual([
      { plateforme: '0020' },
      { plateforme: '0020' },
      { plateforme: '0020' },
    ])
  })
})

describe('AnnuaireConsultationService.resolveRecipient — masquage non-cascade (consumption layer)', () => {
  it('un Masquage SIREN (large) ne masque PAS une Définition SIREN_SIRET (plus spécifique)', async () => {
    const maskingSiren = entry({
      siren: SIREN,
      nature: 'M',
      dateDebut: '20260101',
      plateforme: '9998',
    })
    const definitionSiret = entry({
      siren: SIREN,
      siret: SIRET,
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0002',
    })
    const service = new AnnuaireConsultationService(
      fakeRepo([maskingSiren, definitionSiret]) as never,
    )

    const result = await service.resolveRecipient(
      TENANT,
      { siren: SIREN, siret: SIRET },
      '20260615',
    )
    expect(result).toEqual({ plateforme: '0002' })
  })

  it('un Masquage SIREN_SIRET (précis) replie sur une Définition SIREN (plus large) si elle existe', async () => {
    const definitionSiren = entry({
      siren: SIREN,
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0001',
    })
    const maskingSiret = entry({
      siren: SIREN,
      siret: SIRET,
      nature: 'M',
      dateDebut: '20260101',
      plateforme: '9998',
    })
    const service = new AnnuaireConsultationService(
      fakeRepo([definitionSiren, maskingSiret]) as never,
    )

    const result = await service.resolveRecipient(
      TENANT,
      { siren: SIREN, siret: SIRET },
      '20260615',
    )
    expect(result).toEqual({ plateforme: '0001' })
  })

  it('un Masquage EXACTEMENT à la maille cible, sans repli possible, lève RecipientUnaddressableError', async () => {
    const maskingSiret = entry({
      siren: SIREN,
      siret: SIRET,
      nature: 'M',
      dateDebut: '20260101',
      plateforme: '9998',
    })
    const definitionSiret = entry({
      siren: SIREN,
      siret: SIRET,
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0002',
    })
    const service = new AnnuaireConsultationService(
      fakeRepo([maskingSiret, definitionSiret]) as never,
    )

    await expect(
      service.resolveRecipient(
        TENANT,
        { siren: SIREN, siret: SIRET },
        '20260615',
      ),
    ).rejects.toBeInstanceOf(RecipientUnaddressableError)
  })
})

describe('AnnuaireConsultationService.resolveRecipient — propagation des erreurs typées', () => {
  it('propage RecipientUnaddressableError sans aucune ligne couvrante', async () => {
    const service = new AnnuaireConsultationService(fakeRepo([]) as never)
    await expect(
      service.resolveRecipient(TENANT, { siren: SIREN }, '20260615'),
    ).rejects.toBeInstanceOf(RecipientUnaddressableError)
  })

  it('propage AmbiguousResolutionError sur un départage inter-maille indéterminé (routage vs suffixe, même rang)', async () => {
    const viaRoutage = entry({
      siren: SIREN,
      siret: SIRET,
      routageId: 'ROUTE1',
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0003',
    })
    const viaSuffixe = entry({
      siren: SIREN,
      suffixe: 'SUF1',
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0004',
    })
    const service = new AnnuaireConsultationService(
      fakeRepo([viaRoutage, viaSuffixe]) as never,
    )
    await expect(
      service.resolveRecipient(
        TENANT,
        { siren: SIREN, siret: SIRET, routageId: 'ROUTE1', suffixe: 'SUF1' },
        '20260615',
      ),
    ).rejects.toBeInstanceOf(AmbiguousResolutionError)
  })
})

describe('AnnuaireConsultationService.listDirectoryEntries', () => {
  it('mappe les entrées du miroir vers la vue publique (nature/dates/plateforme)', async () => {
    const e = entry({
      siren: SIREN,
      siret: SIRET,
      nature: 'D',
      dateDebut: '20260101',
      dateFin: '20261231',
      plateforme: '0002',
      sourceHorodate: '20260101090000',
    })
    const service = new AnnuaireConsultationService(fakeRepo([e]) as never)
    const result = await service.listDirectoryEntries(TENANT, SIREN)
    expect(result).toEqual([
      {
        id: e.id,
        siren: SIREN,
        siret: SIRET,
        routageId: null,
        suffixe: null,
        nature: 'D',
        dateDebut: '20260101',
        dateFin: '20261231',
        plateforme: '0002',
        sourceHorodate: '20260101090000',
      },
    ])
  })
})
