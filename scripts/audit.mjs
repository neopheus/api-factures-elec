#!/usr/bin/env node
// Audit de sécurité des dépendances résolues du monorepo.
//
// Pourquoi ce script existe : `pnpm audit` (pnpm 10.12.1 comme pnpm 11.x)
// interroge l'ancien endpoint `GET /-/npm/v1/security/audits` de
// registry.npmjs.org, que npm a retiré (réponse 4xx systématique, vérifié
// empiriquement 5/5). Ce n'est pas une vulnérabilité ni un problème de nos
// dépendances : c'est l'outil `pnpm audit` lui-même qui est cassé, sur les
// deux branches majeures de pnpm disponibles. On ne peut pas monter en
// version de pnpm pour contourner (pnpm 11 tape le même endpoint mort et
// abandonne le support de `pnpm.overrides`/`pnpm.updateConfig` dans
// package.json). Ce script interroge donc directement le nouvel endpoint
// officiel utilisé par npm lui-même :
//   POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk
//   body: { "<nom-paquet>": ["<version>", ...], ... }
// qui répond 200 avec une map paquet → advisories[] (vérifié empiriquement).
//
// Principe : on énumère l'arbre de dépendances RÉSOLU (transitives comprises,
// via `pnpm ls -r --depth Infinity --json`), donc les `pnpm.overrides` du
// package.json racine (esbuild, postcss) sont déjà appliqués — auditer
// l'arbre résolu revient naturellement à auditer les versions effectives
// après override, sans logique spécifique à écrire pour ça.
//
// Important (vérifié empiriquement) : quand on interroge l'endpoint avec
// PLUSIEURS versions d'un même paquet en une fois, la réponse contient
// l'UNION de toutes les advisories concernant N'IMPORTE LAQUELLE des
// versions envoyées — elle ne dit pas quelle version précise est touchée.
// On ne peut donc pas se contenter de « advisories non vide pour ce paquet
// ⇒ vulnérable » : il faut, pour chaque advisory retournée, retester
// nous-mêmes la version installée contre le champ `vulnerable_versions`
// (une plage semver) avant de conclure.
//
// Semver : cette plage n'utilise, dans les données réelles observées
// (GitHub Advisory Database), que des comparateurs simples (<, <=, >, >=,
// =) combinés par des espaces (ET) — jamais de tilde/caret/x-range/plage à
// tiret dans notre échantillon. Le mini-moteur ci-dessous ne gère que ce
// sous-ensemble et échoue FERMÉ : toute plage qu'il ne sait pas interpréter
// est traitée comme suspecte (à vérifier manuellement), jamais comme saine.
//
// Aucune dépendance runtime ajoutée : fetch et child_process sont natifs
// (Node >= 22).

import { execFileSync } from 'node:child_process'

const BULK_ENDPOINT =
  'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'
const CHUNK_SIZE = 150 // validé empiriquement (754 paquets → 6 lots, tous 200 OK)
const MAX_ATTEMPTS = 3

function logInfo(message) {
  console.log(message)
}

function logErr(message) {
  console.error(message)
}

// --- 1. Énumération de l'arbre de dépendances résolu (transitives incluses) ---

const RESOLVABLE_VERSION_RE =
  /^\d+(\.\d+){0,2}(-[0-9A-Za-z-.]+)?(\+[0-9A-Za-z-.]+)?$/

function isResolvableSemver(version) {
  return RESOLVABLE_VERSION_RE.test(version)
}

function enumerateInstalledPackages() {
  const raw = execFileSync(
    'pnpm',
    ['ls', '-r', '--depth', 'Infinity', '--json'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 128 },
  )
  const workspaces = JSON.parse(raw)

  const map = new Map() // nom -> Set<version>
  let skipped = 0

  function addVersion(name, rawVersion) {
    // pnpm peut suffixer avec des infos de peer dep, ex "1.2.3(react@18.0.0)"
    const version = rawVersion.split('(')[0]
    if (!isResolvableSemver(version)) {
      // ex: "link:../../packages/invoice-core" (paquet interne du workspace,
      // non publié sur npm, pas d'advisory possible) ou alias "link:" divers.
      skipped++
      return
    }
    if (!map.has(name)) map.set(name, new Set())
    map.get(name).add(version)
  }

  function walk(depsObj) {
    if (!depsObj) return
    for (const [name, info] of Object.entries(depsObj)) {
      if (info?.version) addVersion(name, info.version)
      if (info?.dependencies) walk(info.dependencies)
    }
  }

  for (const ws of workspaces) {
    walk(ws.dependencies)
    walk(ws.devDependencies)
    walk(ws.optionalDependencies)
    walk(ws.unsavedDependencies)
  }

  return { map, skipped }
}

// --- 2. Interrogation de l'endpoint bulk npm (par lots) ---

async function fetchJsonWithRetry(url, body) {
  let lastError
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        throw new Error(
          `endpoint bulk npm advisories a répondu ${res.status} ${res.statusText}`,
        )
      }
      return await res.json()
    } catch (err) {
      lastError = err
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 500 * attempt))
      }
    }
  }
  throw lastError
}

async function fetchAdvisories(map) {
  const names = [...map.keys()]
  const advisoriesByPackage = {}

  for (let i = 0; i < names.length; i += CHUNK_SIZE) {
    const chunkNames = names.slice(i, i + CHUNK_SIZE)
    const body = {}
    for (const name of chunkNames) body[name] = [...map.get(name)]
    const json = await fetchJsonWithRetry(BULK_ENDPOINT, body)
    Object.assign(advisoriesByPackage, json)
  }

  return advisoriesByPackage
}

// --- 3. Mini-moteur semver (sous-ensemble : <, <=, >, >=, =, ET par espace, OU par ||) ---

const VERSION_RE =
  /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/

function parseVersion(raw) {
  const m = VERSION_RE.exec(raw.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: m[2] !== undefined ? Number(m[2]) : 0,
    patch: m[3] !== undefined ? Number(m[3]) : 0,
    prerelease: m[4] ? m[4].split('.') : [],
  }
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1 // pas de prerelease > avec prerelease
  if (b.length === 0) return -1
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const ai = a[i]
    const bi = b[i]
    const aNum = /^\d+$/.test(ai)
    const bNum = /^\d+$/.test(bi)
    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi)
      if (diff !== 0) return Math.sign(diff)
    } else if (aNum && !bNum) {
      return -1
    } else if (!aNum && bNum) {
      return 1
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1
    }
  }
  return Math.sign(a.length - b.length)
}

function compareVersions(a, b) {
  if (a.major !== b.major) return Math.sign(a.major - b.major)
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor)
  if (a.patch !== b.patch) return Math.sign(a.patch - b.patch)
  return comparePrerelease(a.prerelease, b.prerelease)
}

function parseComparator(token) {
  const m = /^(<=|>=|<|>|=)?\s*(.+)$/.exec(token)
  if (!m) return null
  const operator = m[1] ?? '='
  const version = parseVersion(m[2])
  if (!version) return null
  return { operator, version }
}

function comparatorMatches(installed, comparator) {
  const cmp = compareVersions(installed, comparator.version)
  switch (comparator.operator) {
    case '<':
      return cmp < 0
    case '<=':
      return cmp <= 0
    case '>':
      return cmp > 0
    case '>=':
      return cmp >= 0
    case '=':
      return cmp === 0
    default:
      return false
  }
}

/**
 * Teste une version installée contre une plage `vulnerable_versions`.
 * Retourne { supported, matches } :
 *  - supported=false : la plage contient une syntaxe non reconnue (tilde,
 *    caret, x-range, plage à tiret...) → à traiter comme suspect, jamais
 *    comme sain (échec fermé).
 *  - supported=true, matches=true  : la version installée est dans la plage
 *    vulnérable.
 *  - supported=true, matches=false : la plage est comprise et la version
 *    installée n'est pas concernée.
 */
function satisfiesRange(installedRaw, rangeStr) {
  const installed = parseVersion(installedRaw)
  if (!installed) return { supported: false, matches: false }

  const orGroups = String(rangeStr ?? '')
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean)
  if (orGroups.length === 0) return { supported: false, matches: false }

  let hadUnparseableGroup = false
  for (const group of orGroups) {
    const tokens = group.split(/\s+/).filter(Boolean)
    const comparators = tokens.map(parseComparator)
    if (tokens.length === 0 || comparators.some((c) => c === null)) {
      hadUnparseableGroup = true
      continue
    }
    if (comparators.every((c) => comparatorMatches(installed, c))) {
      return { supported: true, matches: true }
    }
  }
  if (hadUnparseableGroup) return { supported: false, matches: false }
  return { supported: true, matches: false }
}

// --- 4. Orchestration + rapport français ---

async function main() {
  const { map, skipped } = enumerateInstalledPackages()
  const totalPairs = [...map.values()].reduce((acc, s) => acc + s.size, 0)
  logInfo(
    `📦 ${map.size} paquets uniques, ${totalPairs} couples nom+version à vérifier ` +
      `(${skipped} version(s) ignorée(s) : liens locaux du workspace, non publiés sur npm).`,
  )

  const advisoriesByPackage = await fetchAdvisories(map)

  const findings = []
  for (const [pkg, advisories] of Object.entries(advisoriesByPackage)) {
    const versions = map.get(pkg)
    if (!versions) continue
    for (const version of versions) {
      for (const advisory of advisories) {
        const result = satisfiesRange(version, advisory.vulnerable_versions)
        if (!result.supported) {
          findings.push({
            package: pkg,
            version,
            severity: advisory.severity,
            title: advisory.title,
            url: advisory.url,
            range: advisory.vulnerable_versions,
            note: 'plage de versions non interprétable par le script — vérification manuelle requise',
          })
        } else if (result.matches) {
          findings.push({
            package: pkg,
            version,
            severity: advisory.severity,
            title: advisory.title,
            url: advisory.url,
            range: advisory.vulnerable_versions,
          })
        }
      }
    }
  }

  if (findings.length === 0) {
    logInfo(
      `✅ 0 vulnérabilité applicable sur ${map.size} paquets résolus ` +
        `(source : endpoint bulk npm advisories, https://registry.npmjs.org/-/npm/v1/security/advisories/bulk).`,
    )
    process.exit(0)
  }

  logErr(`❌ ${findings.length} vulnérabilité(s) applicable(s) détectée(s) :\n`)
  for (const f of findings) {
    logErr(
      `- ${f.package}@${f.version} [${f.severity ?? 'sévérité inconnue'}] ${f.title}`,
    )
    logErr(`  plage vulnérable : ${f.range}`)
    logErr(`  détail : ${f.url}`)
    if (f.note) logErr(`  ⚠️  ${f.note}`)
    logErr('')
  }
  process.exit(1)
}

main().catch((err) => {
  logErr(`💥 échec technique de l'audit de sécurité : ${err?.stack ?? err}`)
  process.exit(2)
})
