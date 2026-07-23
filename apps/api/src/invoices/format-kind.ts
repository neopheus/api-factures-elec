import type { FormatKind } from './format-generator.port.js'

// Exporté (Task 1, phase 4 it.1) : source unique réutilisée par la doc
// OpenAPI (`invoices.openapi-metadata.ts#FORMAT_PARAM`, enum du paramètre
// `:format`) — aucun changement de comportement runtime, ajout de visibilité
// pur sur une constante déjà figée.
export const KINDS: readonly FormatKind[] = [
  'ubl',
  'cii',
  'facturx',
  'flux_base',
  'flux_full',
]

export function parseFormatKind(value: string): FormatKind | null {
  return (KINDS as readonly string[]).includes(value)
    ? (value as FormatKind)
    : null
}
