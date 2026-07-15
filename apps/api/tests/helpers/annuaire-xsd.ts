import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Miroir tests/helpers/ereporting-xsd.ts pour l'annuaire (Task 3, plan 2.4).
// Aucun des 3 XSD annuaire (Actualisation/Consultation/Commun) ne déclare de
// `targetNamespace` (D3, plan-2-4-review.md §1, vérifié xmllint) : les
// instances sont SANS préfixe de namespace. Annuaire_Commun.xsd est inclus
// (xs:include, chemin relatif) — xmllint le résout depuis le dossier du XSD
// pointé par --schema, donc on cible les XSD DGFiP EN PLACE
// (docs/reglementaire, LECTURE SEULE).
export const ANNUAIRE_ACTUALISATION_XSD = resolve(
  import.meta.dirname,
  '../../../../docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/0 - Annuaire/actualisation/Annuaire_Actualisation_F12-F13.xsd',
)
export const ANNUAIRE_CONSULTATION_XSD = resolve(
  import.meta.dirname,
  '../../../../docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/0 - Annuaire/consultation/Annuaire_Consultation_F14.xsd',
)

export interface XsdValidationResult {
  valid: boolean
  errors: string
}

function validateAgainstXsd(xsdPath: string, xml: string): XsdValidationResult {
  const dir = mkdtempSync(join(tmpdir(), 'factelec-annuaire-xsd-'))
  const xmlPath = join(dir, 'instance.xml')
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

export function validateAgainstAnnuaireActualisationXsd(
  xml: string,
): XsdValidationResult {
  return validateAgainstXsd(ANNUAIRE_ACTUALISATION_XSD, xml)
}

export function validateAgainstAnnuaireConsultationXsd(
  xml: string,
): XsdValidationResult {
  return validateAgainstXsd(ANNUAIRE_CONSULTATION_XSD, xml)
}
