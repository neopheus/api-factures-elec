import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Chemin du XSD DGFiP annuaire — Consultation F14 (LECTURE SEULE,
// docs/reglementaire). MÊME résolution relative que
// tests/helpers/annuaire-xsd.ts (l'équivalent synchrone réservé aux tests
// unitaires) : ce fichier PROD vit à la MÊME profondeur sous
// apps/api/{src,dist}/annuaire/ que apps/api/tests/helpers/ (2 niveaux sous
// apps/api dans les deux cas) — donc le même nombre de remontées `..` résout
// le même chemin en dev (tsx, depuis src/), en test (vitest+swc, depuis
// src/) ET en prod (swc --out-dir dist --strip-leading-paths, depuis dist/ —
// miroir 1:1 de src/). Même discipline que ereporting-xsd-validator.ts
// (Task 8, e-reporting).
export const ANNUAIRE_CONSULTATION_XSD_PATH = resolve(
  import.meta.dirname,
  '../../../../docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/0 - Annuaire/consultation/Annuaire_Consultation_F14.xsd',
)

// Chemin du XSD DGFiP annuaire — Actualisation F13 (Task 8, prod validator :
// AnnuairePublicationService valide le F13 QU'ELLE VIENT DE GÉNÉRER, avant
// tout appel au port de transmission — miroir EreportingGenerationService
// /validateEreportingXml, 2.3-T8). Même résolution relative que
// tests/helpers/annuaire-xsd.ts (ANNUAIRE_ACTUALISATION_XSD).
export const ANNUAIRE_ACTUALISATION_XSD_PATH = resolve(
  import.meta.dirname,
  '../../../../docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/0 - Annuaire/actualisation/Annuaire_Actualisation_F12-F13.xsd',
)

export interface XsdValidationResult {
  valid: boolean
  errors: string
}

// Erreur OPÉRATIONNELLE (miroir XsdToolingError, ereporting-xsd-validator.ts)
// : xmllint absent du PATH, ou toute autre erreur d'EXÉCUTION de l'outil —
// PAS un problème avec le contenu XML lui-même. DISTINCTE d'un rejet
// sémantique : l'appelant (Task 9, worker d'ingestion F14) DOIT la laisser
// remonter (throw -> retry) ; un F14 par ailleurs valide ne doit JAMAIS être
// traité comme invalide parce que l'outil manque sur l'hôte. Déploiement :
// libxml2 (binaire `xmllint`) est un PRÉREQUIS de l'hôte worker, non fourni
// par les dépendances npm.
export class AnnuaireXsdToolingError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `xmllint indisponible ou erreur d'outillage annuaire (libxml2 requis sur l'hôte) : ${detail}`,
      { cause },
    )
    this.name = 'AnnuaireXsdToolingError'
  }
}

// Validation XSD DGFiP (PROD, async — execFile, jamais execFileSync) — noyau
// partagé par les deux sens du flux annuaire (Consultation F14 reçue,
// Actualisation F13 générée). Distingue TROIS issues (jamais confondues,
// discipline Task 8 e-reporting #6) :
//  (a) XML valide -> { valid: true } ;
//  (b) XML XSD-invalide (xmllint s'exécute, rapporte des erreurs de schéma
//      sur stderr) -> { valid: false, errors } — rejet SÉMANTIQUE ;
//  (c) outillage indisponible/erreur d'exécution (ENOENT, pas de stderr de
//      schéma exploitable) -> AnnuaireXsdToolingError LEVÉE — erreur
//      opérationnelle, jamais un rejet.
// `opts.binary` n'est overridable QUE pour forcer déterministement le chemin
// ENOENT en test (jamais en usage normal).
async function validateAgainstXsd(
  xsdPath: string,
  xml: string,
  opts: { binary?: string },
): Promise<XsdValidationResult> {
  const binary = opts.binary ?? 'xmllint'
  const dir = await mkdtemp(join(tmpdir(), 'factelec-annuaire-xsd-'))
  const xmlPath = join(dir, 'instance.xml')
  try {
    await writeFile(xmlPath, xml, 'utf8')
    try {
      await execFileAsync(binary, ['--noout', '--schema', xsdPath, xmlPath])
      return { valid: true, errors: '' }
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { stderr?: string }
      if (e.code === 'ENOENT' || !e.stderr) {
        throw new AnnuaireXsdToolingError(e)
      }
      return { valid: false, errors: e.stderr }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function validateAnnuaireConsultationXml(
  xml: string,
  opts: { binary?: string } = {},
): Promise<XsdValidationResult> {
  return validateAgainstXsd(ANNUAIRE_CONSULTATION_XSD_PATH, xml, opts)
}

// Validation PROD du F13 (Actualisation) — appelée par
// AnnuairePublicationService sur le XML QU'ELLE VIENT ELLE-MÊME DE GÉNÉRER
// (defense-in-depth : generateActualisationXml/Task 3 est déjà testé
// XSD-valide à 100 % sur golden vectors, cette validation couvre un champ
// non contraint par un pattern XSD positif — ex. Suffixe/RoutageId,
// xs:token libre — qui échapperait à la validation zod de la frontière HTTP
// mais resterait structurellement invalide une fois sérialisé). Un échec ICI
// est un rejet born-rejetee (Task 8), jamais une transition depuis `draft`.
export async function validateAnnuaireActualisationXml(
  xml: string,
  opts: { binary?: string } = {},
): Promise<XsdValidationResult> {
  return validateAgainstXsd(ANNUAIRE_ACTUALISATION_XSD_PATH, xml, opts)
}
