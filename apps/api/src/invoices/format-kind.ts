import type { FormatKind } from './format-generator.port.js'

const KINDS: readonly FormatKind[] = [
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
