import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)

const ref = (p: string) =>
  resolve(
    import.meta.dirname,
    '../../../../docs/reference/en16931-schematron/1.3.16/xslt',
    p,
  )
const sef = (p: string) => resolve(import.meta.dirname, '../.sef', p)

// UBL_SEF conserve exactement son chemin d'origine (`../.sef/EN16931-UBL-validation.sef.json`,
// identique à l'ancienne constante `SEF`) : d'autres tests en dépendent.
const PAIRS: ReadonlyArray<{ xslt: string; sef: string }> = [
  {
    xslt: ref('EN16931-UBL-validation.xslt'),
    sef: sef('EN16931-UBL-validation.sef.json'),
  },
  {
    xslt: ref('EN16931-CII-validation.xslt'),
    sef: sef('EN16931-CII-validation.sef.json'),
  },
]

// Compile une seule fois chaque Schematron (XSLT 2.0) en SEF SaxonJS, si absent ou périmé.
export default function setup(): void {
  const xslt3Bin = require.resolve('xslt3')
  for (const { xslt, sef: out } of PAIRS) {
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(xslt).mtimeMs)
      continue
    mkdirSync(dirname(out), { recursive: true })
    execFileSync(
      process.execPath,
      [xslt3Bin, `-xsl:${xslt}`, `-export:${out}`, '-nogo'],
      {
        stdio: 'pipe',
      },
    )
  }
}
