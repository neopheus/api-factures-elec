import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// ereporting.xsd importe report/transaction/payment/parametre par schemaLocation
// RELATIF : xmllint résout ces imports depuis le dossier du XSD. On pointe donc
// --schema sur le fichier DGFiP en place (docs/reglementaire en LECTURE SEULE).
export const EREPORTING_XSD = resolve(
  import.meta.dirname,
  '../../../../docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/1 - E-reporting/ereporting.xsd',
)

export function validateAgainstEreportingXsd(xml: string): {
  valid: boolean
  errors: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'factelec-ereport-xsd-'))
  const xmlPath = join(dir, 'report.xml')
  writeFileSync(xmlPath, xml, 'utf8')
  try {
    execFileSync('xmllint', ['--noout', '--schema', EREPORTING_XSD, xmlPath], {
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
