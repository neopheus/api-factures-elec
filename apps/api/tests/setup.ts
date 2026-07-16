import 'reflect-metadata'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ConfigModule.forRoot() valide process.env de façon EAGER, au chargement du
// module — avant qu'un test ait pu poser sa propre valeur (ex: createTestApp
// pointant sur le conteneur Testcontainers). Un placeholder syntaxiquement
// valide suffit ici : les e2e qui montent l'app complète overrident ensuite le
// provider APP_POOL avec le pool réel — cette valeur ne sert jamais à une
// connexion effective.
process.env.DATABASE_URL ??=
  'postgres://placeholder:placeholder@localhost:5432/placeholder'
// Idem pour LOG_LEVEL : évite de polluer stdout avec les logs HTTP pino des
// e2e qui montent l'app complète (health.e2e.test.ts).
process.env.LOG_LEVEL ??= 'silent'

// HERMÉTISME (revue 2.4-T9 F1) : les drivers `local` des ports (archive 2.2,
// transmission e-reporting 2.3, annuaire 2.4) écrivent par défaut dans
// ./var/* — un e2e montant l'app complète (createTestApp, sans override de
// port) polluerait le répertoire de travail avec de VRAIS artefacts
// write-once (constaté : annuaire-publication.e2e → ./var/annuaire). On
// pointe donc chaque *_LOCAL_DIR vers un tmpdir PAR PROCESSUS de test,
// nettoyé par l'OS — aucun test n'écrit dans le dépôt. Les valeurs ne
// s'appliquent que si l'environnement ne les fixe pas déjà (??=), et AVANT
// le chargement eager de ConfigModule (ce fichier est le setup vitest).
const hermeticDir = mkdtempSync(join(tmpdir(), 'factelec-tests-'))
process.env.ARCHIVE_LOCAL_DIR ??= join(hermeticDir, 'archive')
process.env.EREPORTING_LOCAL_DIR ??= join(hermeticDir, 'ereporting')
process.env.ANNUAIRE_LOCAL_DIR ??= join(hermeticDir, 'annuaire')
