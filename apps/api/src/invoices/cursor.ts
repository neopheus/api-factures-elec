export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url')
}

export function decodeCursor(
  cursor: string,
): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    const sep = decoded.indexOf('|')
    if (sep <= 0) return null
    const createdAt = decoded.slice(0, sep)
    const id = decoded.slice(sep + 1)
    if (!id || Number.isNaN(Date.parse(createdAt))) return null
    return { createdAt, id }
  } catch {
    return null
  }
}
