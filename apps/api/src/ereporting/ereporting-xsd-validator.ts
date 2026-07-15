import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Chemin du XSD DGFiP e-reporting (LECTURE SEULE, docs/reglementaire). MÊME
// résolution relative que tests/helpers/ereporting-xsd.ts (l'équivalent
// synchrone réservé aux tests unitaires de flux10-xml.ts) : ce fichier PROD
// vit à la MÊME profondeur sous apps/api/{src,dist}/ereporting/ que
// apps/api/tests/helpers/ (2 niveaux sous apps/api dans les deux cas) — donc
// le même nombre de remontées `..` résout le même chemin en dev (tsx, depuis
// src/), en test (vitest+swc, depuis src/) ET en prod (swc --out-dir dist
// --strip-leading-paths, depuis dist/ — miroir 1:1 de src/, cf. package.json
// `build`). Vérifié empiriquement (Task 8, gate build+typecheck+test).
export const EREPORTING_XSD_PATH = resolve(
  import.meta.dirname,
  '../../../../docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/1 - E-reporting/ereporting.xsd',
)

export interface XsdValidationResult {
  valid: boolean
  errors: string
}

// Erreur OPÉRATIONNELLE (Task 8, injection revue #6) : xmllint absent du
// PATH, ou toute autre erreur d'EXÉCUTION de l'outil (permissions, schéma
// introuvable...) — PAS un problème avec le contenu XML lui-même. DISTINCTE
// d'un rejet sémantique : le worker DOIT la laisser remonter (throw -> retry
// BullMQ, cf. ereporting-generation.service.ts) ; un XML par ailleurs valide
// ne doit JAMAIS être marqué `rejetee` parce que l'outil manque sur l'hôte.
// Déploiement : libxml2 (binaire `xmllint`) est un PRÉREQUIS de l'hôte
// worker, non fourni par les dépendances npm — à documenter dans l'image/
// le runbook de déploiement du process worker (start:worker).
export class XsdToolingError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `xmllint indisponible ou erreur d'outillage e-reporting (libxml2 requis sur l'hôte worker) : ${detail}`,
      { cause },
    )
    this.name = 'XsdToolingError'
  }
}

// Validation XSD DGFiP (PROD, async — execFile, jamais execFileSync côté
// worker) du flux Flux 10 généré. Distingue TROIS issues (jamais confondues,
// injection Task 8 #6) :
//  (a) XML valide -> { valid: true } ;
//  (b) XML XSD-invalide (xmllint s'exécute, rapporte des erreurs de schéma
//      sur stderr) -> { valid: false, errors } — rejet SÉMANTIQUE, motif
//      REJ_SEMAN côté appelant ;
//  (c) outillage indisponible/erreur d'exécution (ENOENT, pas de stderr de
//      schéma exploitable) -> XsdToolingError LEVÉE — erreur opérationnelle,
//      jamais un rejet.
// `opts.binary` n'est overridable QUE pour forcer déterministement le
// chemin ENOENT en test (jamais en usage normal, cf.
// tests/unit/ereporting-xsd-validator.test.ts).
export async function validateEreportingXml(
  xml: string,
  opts: { binary?: string } = {},
): Promise<XsdValidationResult> {
  const binary = opts.binary ?? 'xmllint'
  const dir = await mkdtemp(join(tmpdir(), 'factelec-ereport-xsd-'))
  const xmlPath = join(dir, 'report.xml')
  try {
    await writeFile(xmlPath, xml, 'utf8')
    try {
      await execFileAsync(binary, [
        '--noout',
        '--schema',
        EREPORTING_XSD_PATH,
        xmlPath,
      ])
      return { valid: true, errors: '' }
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { stderr?: string }
      // ENOENT (binaire introuvable) OU aucune sortie stderr exploitable
      // (l'outil a échoué avant même de valider quoi que ce soit) :
      // outillage — JAMAIS un rejet sémantique (cf. XsdToolingError).
      if (e.code === 'ENOENT' || !e.stderr) {
        throw new XsdToolingError(e)
      }
      return { valid: false, errors: e.stderr }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
