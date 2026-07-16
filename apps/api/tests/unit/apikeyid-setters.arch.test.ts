import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Verrou d'architecture (D9 + AMENDEMENT M3, plan 3.3) sur le footgun
// `apiKeyId` : `req.apiKeyId` posé par un guard court-circuite RolesGuard/
// CsrfGuard (`if (req.apiKeyId) return true`). Ce test grep-structurel FIGE
// qui a le droit de poser/lire ce champ.
//
// HONNÊTETÉ (M3-a) : ceci est un RALENTISSEUR, pas un « asservissement » —
// un grep multi-formes reste contournable par un renommage de propriété, un
// helper qui construit l'objet ailleurs, ou toute transformation qui
// n'emprunte aucune des formes syntaxiques ci-dessous. Le garde composé
// `DualAuthMutationGuard` (différé à l'apparition d'une 2ᵉ route dual-auth,
// cf. plan D9) resterait LA vraie barrière d'exécution. Ce test échoue
// volontairement au moindre nouveau poseur/lecteur textuel — c'est son seul
// objectif : ralentir une régression silencieuse, pas la rendre impossible.
//
// Limite connue et acceptée : les commentaires sont retirés avant le
// filtrage (`stripComments`) pour ne pas faire échouer le test sur de la
// prose documentaire (ex. payments.controller.ts mentionne `req.apiKeyId`
// dans un commentaire) — une chaîne littérale contenant `//` à l'intérieur
// d'une chaîne de caractères pourrait en théorie être tronquée à tort ;
// aucun fichier réel du dépôt ne présente ce cas au moment d'écrire ce test.

const SRC_ROOT = resolve(import.meta.dirname, '../../src')

const ALLOWED_SETTERS = new Set([
  'auth/api-key.guard.ts',
  'auth/tenant-auth.guard.ts',
])
const ALLOWED_READERS = new Set(['auth/roles.guard.ts', 'auth/csrf.guard.ts'])

// Formes d'écriture requises au minimum par l'AMENDEMENT M3 : `.apiKeyId =`,
// `['apiKeyId'] =`, `["apiKeyId"] =` — peu importe le receveur (capture aussi
// un alias de `req`, ex. `const r = req; r.apiKeyId = ...`, ou un cast
// `(req as any).apiKeyId = ...`).
const WRITE_PATTERNS = [
  /\.apiKeyId\s*=(?!=)/,
  /\['apiKeyId'\]\s*=(?!=)/,
  /\["apiKeyId"\]\s*=(?!=)/,
]

// Mêmes formes, en lecture (accès sans assignation directe : `if (x.apiKeyId)`,
// `x.apiKeyId ?? ...`, `x['apiKeyId']`, etc.).
const READ_PATTERNS = [/\.apiKeyId\b/, /\['apiKeyId'\]/, /\["apiKeyId"\]/]

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

// Classification PAR LIGNE (pas par occurrence isolée) : une ligne du type
// `req.apiKeyId = auth.apiKeyId` contient bien DEUX occurrences textuelles de
// `apiKeyId`, mais la seconde (valeur copiée depuis l'objet d'authentification
// renvoyé par ApiKeyService, qui expose lui aussi un champ `apiKeyId` —
// concept différent de `req.apiKeyId`) n'est pas une lecture de bypass : dès
// qu'une ligne contient une écriture reconnue, elle est classée écriture et
// n'est PAS re-testée comme lecture.
function scanFile(path: string): { writes: string[]; reads: string[] } {
  const code = stripComments(readFileSync(path, 'utf8'))
  const writes: string[] = []
  const reads: string[] = []
  for (const line of code.split('\n')) {
    if (WRITE_PATTERNS.some((re) => re.test(line))) {
      writes.push(line.trim())
      continue
    }
    if (READ_PATTERNS.some((re) => re.test(line))) {
      reads.push(line.trim())
    }
  }
  return { writes, reads }
}

describe('verrou d’architecture : poseurs/lecteurs de req.apiKeyId', () => {
  const files = listTsFiles(SRC_ROOT)

  it('SEULS api-key.guard.ts et tenant-auth.guard.ts écrivent apiKeyId (.apiKeyId=, [\'apiKeyId\']=, ["apiKeyId"]=)', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = file.slice(SRC_ROOT.length + 1)
      const { writes } = scanFile(file)
      if (writes.length > 0 && !ALLOWED_SETTERS.has(rel)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('SEULS roles.guard.ts et csrf.guard.ts lisent apiKeyId pour bypass (.apiKeyId, [\'apiKeyId\'], ["apiKeyId"])', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = file.slice(SRC_ROOT.length + 1)
      const { reads } = scanFile(file)
      if (reads.length > 0 && !ALLOWED_READERS.has(rel)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})
