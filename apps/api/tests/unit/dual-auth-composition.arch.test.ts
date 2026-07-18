import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// AMENDEMENT M1 (revue du plan 3.5, D7/Task 4, BINDING) — extension du
// verrou d'architecture (fichier frère d'`apikeyid-setters.arch.test.ts`,
// même famille de motif) : le refus du garde composé `DualAuthMutationGuard`
// (D7) SUR-AFFIRMAIT que le verrou 3.3-T6 (apiKeyId) suffisait — il ne
// couvre QUE le footgun apiKeyId, PAS l'omission pure et simple d'un guard.
// Le résidu bénin (mésordre → fail-CLOSED 403) reste acceptable ; le résidu
// GRAVE ne l'est pas : une route dual-auth de mutation qui OMETTRAIT
// `CsrfGuard` = fail-OPEN CSRF silencieux (une session de N'IMPORTE QUEL
// rôle mute des données sans jeton CSRF). Ce test asserte que TOUTE route
// de MUTATION (@Post/@Put/@Delete) composant `TenantAuthGuard` compose AUSSI
// `RolesGuard` ET `CsrfGuard`, `TenantAuthGuard` EN TÊTE.
//
// HONNÊTETÉ (motif M3, apikeyid-setters.arch.test.ts) : ceci est un
// RALENTISSEUR, pas un asservissement. Scan textuel du bloc de décorateurs
// immédiatement au-dessus de chaque méthode de contrôleur (`@Xxx(...)` en
// lignes consécutives suivies de la signature de méthode) : contournable par
// un guard posé autrement (garde composée custom, `APP_GUARD` global,
// décorateur `@UseGuards` reconstruit dynamiquement, guards de CLASSE
// combinés à des guards de méthode — cf. `api-keys.controller.ts`, ignoré
// par ce scan car il ne compose jamais `TenantAuthGuard`). Ce test ne
// prétend détecter QUE le motif `@UseGuards(...)` réel et actuel du projet.
//
// DÉCOUVERTE (Task 4, plan 3.5, 2026-07-18) puis CORRECTIF (Task 4bis,
// 2026-07-18) : `annuaire.controller.ts` (faille PRÉ-EXISTANTE depuis 2.4
// Tasks 7/8, AVANT ce plan) composait `TenantAuthGuard` SEUL sur 3 routes de
// mutation (`POST lignes`, `PUT lignes/:id`, `DELETE lignes/:id`) — SANS
// `RolesGuard` ni `CsrfGuard`. C'était EXACTEMENT le résidu grave que
// l'extension M1 vise à empêcher — corrigé par Task 4bis (triple garde
// `TenantAuthGuard, RolesGuard, CsrfGuard` + `@Roles('owner','admin',
// 'accountant')`, motif EXACT des 3 routes dual-auth ci-dessous). Liste
// d'exclusion VIDÉE (plus aucune dette documentée) : le verrou couvre
// désormais ces 3 routes comme toutes les autres — si l'une d'elles perdait
// un jour un des 3 guards, le test `qualifying` (dernier `it` ci-dessous)
// casserait immédiatement.
const KNOWN_PRE_EXISTING_GAPS = new Set<string>([])

const SRC_ROOT = resolve(import.meta.dirname, '../../src')
const MUTATION_VERBS = ['@Post', '@Put', '@Delete']

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function listControllerFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listControllerFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.controller.ts')) {
      out.push(full)
    }
  }
  return out
}

interface RouteGuards {
  methodName: string
  isMutation: boolean
  guards: string[] | null // null = aucun @UseGuards de méthode trouvé
}

// Capture l'identifiant d'une méthode/propriété suivie d'une parenthèse
// ouvrante (le début d'une liste de paramètres, même si la signature se
// poursuit sur plusieurs lignes — cf. `capture(`/`mask(` dans ce projet).
function extractMethodName(line: string): string | null {
  const m = line.match(
    /^(?:private\s+|protected\s+|public\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/,
  )
  return m ? (m[1] ?? null) : null
}

// Regroupe chaque bloc CONSÉCUTIF de lignes `@...` avec la première ligne de
// code non-décorateur qui le suit (la signature de méthode) — les guards de
// CLASSE et les décorateurs de PARAMÈTRES (`@CurrentTenant()` etc., qui
// suivent la parenthèse ouvrante d'une signature multi-lignes) tombent hors
// d'un bloc valide et sont naturellement ignorés (aucun nom de méthode
// n'est extrait depuis `export class Xxx {` ni depuis `): Promise<...> {`).
function scanControllerFile(path: string): RouteGuards[] {
  const code = stripComments(readFileSync(path, 'utf8'))
  const blocks: RouteGuards[] = []
  let decorators: string[] = []

  for (const raw of code.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('@')) {
      decorators.push(line)
      continue
    }
    if (decorators.length > 0) {
      const methodName = extractMethodName(line)
      if (methodName) {
        const isMutation = decorators.some((d) =>
          MUTATION_VERBS.some((verb) => d.startsWith(`${verb}(`)),
        )
        const useGuardsLine = decorators.find((d) =>
          d.startsWith('@UseGuards('),
        )
        const guards = useGuardsLine
          ? (useGuardsLine.match(/@UseGuards\(([^)]*)\)/)?.[1] ?? '')
              .split(',')
              .map((g) => g.trim())
              .filter(Boolean)
          : null
        blocks.push({ methodName, isMutation, guards })
      }
      decorators = []
    }
  }
  return blocks
}

function violatesInvariant(block: RouteGuards): boolean {
  if (!block.isMutation || !block.guards) return false
  if (!block.guards.includes('TenantAuthGuard')) return false
  const hasRoles = block.guards.includes('RolesGuard')
  const hasCsrf = block.guards.includes('CsrfGuard')
  const tenantAuthFirst = block.guards[0] === 'TenantAuthGuard'
  return !(hasRoles && hasCsrf && tenantAuthFirst)
}

describe('verrou d’architecture : composition dual-auth des routes de mutation', () => {
  const files = listControllerFiles(SRC_ROOT)
  const qualifying: string[] = [] // toute route de mutation composant TenantAuthGuard, conforme ou non
  const offenders: string[] = [] // qualifying, non conforme, HORS dette documentée

  for (const file of files) {
    const rel = file.slice(SRC_ROOT.length + 1)
    for (const block of scanControllerFile(file)) {
      if (!block.isMutation || !block.guards?.includes('TenantAuthGuard')) {
        continue
      }
      const key = `${rel}#${block.methodName}`
      qualifying.push(key)
      if (violatesInvariant(block) && !KNOWN_PRE_EXISTING_GAPS.has(key)) {
        offenders.push(key)
      }
    }
  }

  it('le scan repère les 7 routes dual-auth CONFORMES existantes (preuve que le scan n’est pas vide)', () => {
    const compliant = qualifying
      .filter((k) => !KNOWN_PRE_EXISTING_GAPS.has(k))
      .sort()
    expect(compliant).toEqual(
      [
        'annuaire/annuaire.controller.ts#publish',
        'annuaire/annuaire.controller.ts#endEffect',
        'annuaire/annuaire.controller.ts#mask',
        // Task 1, plan 3.6 (amendement B1) : 7e route — révocation de
        // consentement, triple garde sans exclusion.
        'annuaire/annuaire.controller.ts#revokeConsent',
        'ereporting/ereporting.controller.ts#retransmit',
        'invoices/invoices.controller.ts#resolveRouting',
        'payments/payments.controller.ts#capture',
      ].sort(),
    )
  })

  it('aucune dette pré-existante restante (liste d’exclusion vide, Task 4bis a soldé annuaire.controller.ts)', () => {
    expect(KNOWN_PRE_EXISTING_GAPS.size).toBe(0)
  })

  it('TOUTE route de mutation composant TenantAuthGuard compose AUSSI RolesGuard ET CsrfGuard, TenantAuthGuard en tête', () => {
    expect(offenders).toEqual([])
  })
})
