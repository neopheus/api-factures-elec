import { resolve } from 'node:path'
// saxon-js n'a pas de types ; import CommonJS via l'interop ESM.
import SaxonJS from 'saxon-js'

const SEF = resolve(
  import.meta.dirname,
  '../.sef/EN16931-UBL-validation.sef.json',
)

export type SchematronViolation = {
  id: string
  flag: string
  text: string
  location: string
}

// Exécute le Schematron EN 16931 (SEF SaxonJS) sur un document UBL et renvoie
// les assertions en échec extraites du rapport SVRL. 100 % Node, aucune JVM.
// Forme d'appel vérifiée le 2026-07-13 : stylesheetFileName (SEF) + sourceText.
export function validateAgainstSchematron(xml: string): {
  valid: boolean
  failedAsserts: SchematronViolation[]
} {
  const out = SaxonJS.transform(
    { stylesheetFileName: SEF, sourceText: xml, destination: 'serialized' },
    'sync',
  ) as { principalResult: string }
  const svrl = out.principalResult
  const failedAsserts: SchematronViolation[] = []
  const re = /<svrl:failed-assert\b([^>]*)>([\s\S]*?)<\/svrl:failed-assert>/g
  for (const m of svrl.matchAll(re)) {
    const attrs = m[1] ?? ''
    const body = m[2] ?? ''
    const attr = (name: string) =>
      new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? ''
    const textMatch = /<svrl:text>([\s\S]*?)<\/svrl:text>/.exec(body)
    failedAsserts.push({
      id: attr('id'),
      flag: attr('flag'),
      location: attr('location'),
      text: (textMatch?.[1] ?? '').replace(/\s+/g, ' ').trim(),
    })
  }
  return { valid: failedAsserts.length === 0, failedAsserts }
}
