import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)

const XSLT = resolve(
  import.meta.dirname,
  '../../../../docs/reference/en16931-schematron/1.3.16/xslt/EN16931-UBL-validation.xslt',
)
export const SEF = resolve(
  import.meta.dirname,
  '../.sef/EN16931-UBL-validation.sef.json',
)

// Compile une seule fois le Schematron (XSLT 2.0) en SEF SaxonJS, si absent ou périmé.
export default function setup(): void {
  if (existsSync(SEF) && statSync(SEF).mtimeMs >= statSync(XSLT).mtimeMs) return
  mkdirSync(dirname(SEF), { recursive: true })
  const xslt3Bin = require.resolve('xslt3')
  execFileSync(
    process.execPath,
    [xslt3Bin, `-xsl:${XSLT}`, `-export:${SEF}`, '-nogo'],
    {
      stdio: 'pipe',
    },
  )
}
