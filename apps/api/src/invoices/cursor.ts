// `createdAt` accepte soit un Date JS (précision milliseconde — sérialisé via
// toISOString(), comportement historique), soit une chaîne DÉJÀ formatée
// (précision microseconde, ex. la valeur brute `created_at` renvoyée par
// Postgres via to_char en UTC) : le repository doit encoder le curseur à
// partir de cette chaîne microseconde-précise pour la pagination keyset — cf.
// InvoicesRepository.list (fix task-8, précision du curseur).
export function encodeCursor(createdAt: Date | string, id: string): string {
  const value =
    typeof createdAt === 'string' ? createdAt : createdAt.toISOString()
  return Buffer.from(`${value}|${id}`).toString('base64url')
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
