import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REG =
  '../../../../docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/2 - E-invoicing'

export const OASIS_UBL_INVOICE_XSD = resolve(
  import.meta.dirname,
  '../../../../docs/reference/ubl-2.1/maindoc/UBL-Invoice-2.1.xsd',
)
export const OASIS_UBL_CREDITNOTE_XSD = resolve(
  import.meta.dirname,
  '../../../../docs/reference/ubl-2.1/maindoc/UBL-CreditNote-2.1.xsd',
)
export const F1_BASE_UBL_INVOICE_XSD = resolve(
  import.meta.dirname,
  `${REG}/F1_BASE_UBL_2.1/F1BASE_UBL-invoice-2.1.xsd`,
)
export const F1_FULL_UBL_INVOICE_XSD = resolve(
  import.meta.dirname,
  `${REG}/F1_FULL_UBL_2.1/F1FULL_UBL_invoice-2.1.xsd`,
)

// xsdPath par défaut = XSD commercial OASIS (compatibilité avec les tests existants).
export function validateAgainstXsd(
  xml: string,
  xsdPath: string = OASIS_UBL_INVOICE_XSD,
): { valid: boolean; errors: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factelec-xsd-'))
  const xmlPath = join(dir, 'invoice.xml')
  writeFileSync(xmlPath, xml, 'utf8')
  try {
    execFileSync('xmllint', ['--noout', '--schema', xsdPath, xmlPath], {
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
