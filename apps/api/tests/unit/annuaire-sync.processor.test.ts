import { describe, expect, it, vi } from 'vitest'
import { AnnuaireSyncProcessor } from '../../src/worker/annuaire-sync.processor.js'

function build() {
  const syncService = { sync: vi.fn().mockResolvedValue(3) }
  const publicationService = {
    republishDraft: vi.fn().mockResolvedValue('republished'),
  }
  const processor = new AnnuaireSyncProcessor(
    syncService as never,
    publicationService as never,
  )
  return { processor, syncService, publicationService }
}

describe('AnnuaireSyncProcessor.process', () => {
  it('dispatches annuaire-sync jobs to AnnuaireSyncService.sync', async () => {
    const { processor, syncService, publicationService } = build()

    await processor.process({
      name: 'annuaire-sync',
      data: { tenantId: 't1', typeFlux: 'D' },
    } as never)

    expect(syncService.sync).toHaveBeenCalledWith('t1', 'D')
    expect(publicationService.republishDraft).not.toHaveBeenCalled()
  })

  it('dispatches annuaire-republish jobs to AnnuairePublicationService.republishDraft (injection revue Task 9)', async () => {
    const { processor, syncService, publicationService } = build()

    await processor.process({
      name: 'annuaire-republish',
      data: { tenantId: 't1', ligneId: 'ligne-1' },
    } as never)

    expect(publicationService.republishDraft).toHaveBeenCalledWith(
      't1',
      'ligne-1',
    )
    expect(syncService.sync).not.toHaveBeenCalled()
  })

  it('ignores a genuinely unknown job name without throwing (forward-compat)', async () => {
    const { processor, syncService, publicationService } = build()

    await expect(
      processor.process({ name: 'some-future-job', data: {} } as never),
    ).resolves.toBeUndefined()
    expect(syncService.sync).not.toHaveBeenCalled()
    expect(publicationService.republishDraft).not.toHaveBeenCalled()
  })
})
