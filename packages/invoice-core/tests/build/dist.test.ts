import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const pkgRoot = resolve(import.meta.dirname, '../..')
const tsc = resolve(pkgRoot, '../../node_modules/.bin/tsc')
let outDir: string

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'factelec-dist-'))
  // Compile vers un répertoire temporaire : le test est hermétique
  // (il ne dépend pas d'un `pnpm build` préalable).
  execFileSync(
    tsc,
    ['-p', resolve(pkgRoot, 'tsconfig.build.json'), '--outDir', outDir],
    {
      cwd: pkgRoot,
      stdio: 'pipe',
    },
  )
}, 60_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

describe('build dist', () => {
  it('emits the entrypoint, its declaration and declaration map', () => {
    expect(existsSync(join(outDir, 'index.js'))).toBe(true)
    expect(existsSync(join(outDir, 'index.d.ts'))).toBe(true)
    expect(existsSync(join(outDir, 'index.d.ts.map'))).toBe(true)
  })

  it('exposes the public API from the compiled entrypoint', async () => {
    const mod = await import(pathToFileURL(join(outDir, 'index.js')).href)
    expect(typeof mod.buildInvoice).toBe('function')
    expect(typeof mod.generateUbl).toBe('function')
    expect(typeof mod.validateBusinessRules).toBe('function')
  })

  it('declares a clean exports map pointing at dist', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'),
    )
    expect(pkg.exports['.'].types).toBe('./dist/index.d.ts')
    expect(pkg.exports['.'].import).toBe('./dist/index.js')
    expect(pkg.main).toBe('./dist/index.js')
    expect(pkg.types).toBe('./dist/index.d.ts')
  })
})
