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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(value: string): boolean {
  return UUID.test(value)
}
