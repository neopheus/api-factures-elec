#!/usr/bin/env bash
# Empaquette le plugin factelec/ en zip distribuable pour l'installation
# manuelle WordPress (Extensions > Ajouter > Téléverser une extension).
#
# Contenu du zip = UNIQUEMENT le répertoire factelec/ : ni composer.json,
# phpstan.neon, phpunit.xml (outillage dev, à la racine de
# connectors/woocommerce/, jamais dans factelec/), ni tests/, ni vendor/ —
# le plugin n'a AUCUNE dépendance runtime (design §2 ; l'autoloader PSR-4
# de factelec/factelec.php est un spl_autoload_register minimal, pas
# Composer), donc aucun vendor/autoload.php n'est requis en production.
# vendor/ vit hors de factelec/ (généré par `composer install` à la racine
# de ce paquet) : il n'entre jamais dans le zip du simple fait qu'il n'est
# jamais À L'INTÉRIEUR du répertoire zippé. Les exclusions -x ci-dessous
# sont une défense en profondeur si jamais un artefact de dev apparaissait
# malgré tout sous factelec/ (jamais le cas en usage normal).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f factelec/factelec.php ]]; then
    echo "factelec/factelec.php introuvable — lancez ce script depuis connectors/woocommerce/." >&2
    exit 1
fi

# Numéro de version canonique = celui déclaré dans l'en-tête du plugin
# (commentaire "Version: x.y.z"), seule source de vérité (pas de
# composer.json dans factelec/, cf. commentaire ci-dessus).
VERSION="$(grep -m1 '^ \* Version:' factelec/factelec.php | sed -E 's/^ \* Version:[[:space:]]*//')"
if [[ -z "${VERSION}" ]]; then
    echo "Impossible de déterminer la version depuis factelec/factelec.php (en-tête \"Version:\")." >&2
    exit 1
fi

ZIP_NAME="factelec-woocommerce-${VERSION}.zip"

rm -f "${ZIP_NAME}"

zip -r -q "${ZIP_NAME}" factelec/ \
    -x 'factelec/vendor/*' \
    -x '*/.DS_Store' \
    -x '*/.phpunit.cache/*' \
    -x '*/.php-cs-fixer.cache'

echo "Paquet généré : ${SCRIPT_DIR}/${ZIP_NAME}"
