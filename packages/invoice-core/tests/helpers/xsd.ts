import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const XSD_PATH = resolve(
  import.meta.dirname,
  '../../../../docs/reference/ubl-2.1/maindoc/UBL-Invoice-2.1.xsd',
)

export function validateAgainstXsd(xml: string): {
  valid: boolean
  errors: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'factelec-xsd-'))
  const xmlPath = join(dir, 'invoice.xml')
  writeFileSync(xmlPath, xml, 'utf8')
  try {
    execFileSync('xmllint', ['--noout', '--schema', XSD_PATH, xmlPath], {
      stdio: 'pipe',
    })
    return { valid: true, errors: '' }
  } catch (error) {
    const e = error as { stderr?: Buffer }
    return { valid: false, errors: e.stderr?.toString() ?? String(error) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
