import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect } from 'vitest'

const GOLDEN_DIR = resolve(import.meta.dirname, '../golden')

export function expectMatchesGolden(fileName: string, actual: string): void {
  const path = resolve(GOLDEN_DIR, fileName)
  if (!existsSync(path)) {
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(path, actual, 'utf8')
      return
    }
    throw new Error(
      `Golden file manquant : ${fileName}. Lancer avec UPDATE_GOLDEN=1 pour le créer, puis le relire et le committer.`,
    )
  }
  expect(actual).toBe(readFileSync(path, 'utf8'))
}
