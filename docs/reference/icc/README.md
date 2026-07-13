# Profil ICC sRGB vendorisé

- **Fichier** : `sRGB2014.icc`
- **Source** : [International Color Consortium](https://www.color.org/) — registre officiel des profils sRGB, page [`registry.color.org/rgb-registry/srgbprofiles`](https://registry.color.org/rgb-registry/srgbprofiles) (le lien historique `https://www.color.org/profiles/sRGB2014.icc` redirige désormais vers cette page ; fichier récupéré depuis `https://registry.color.org/rgb-registry/profiles/sRGB2014.icc`).
- **Version du profil** : ICC v2.0, RGB/XYZ `mntr`, daté du 15/02/2015, tag MD5 `sRGB2014` (nom du profil).
- **Taille** : 3024 octets.
- **SHA-256** : `384b832de3412066743b52a75ee906b6fb9fb8d9e09e936fc2c43223815c6e0a`

## Conditions de réutilisation

Ce profil est distribué par l'ICC (International Color Consortium), copyright owner déclaré dans son en-tête. Les conditions de réutilisation publiées par l'ICC ([registre des profils](https://registry.color.org/profile-library/#license)) sont :

> "This profile is made available by the International Color Consortium, and may be copied, distributed, embedded, made, used, and sold without restriction. Altered versions of this profile shall have the original identification and copyright information removed and shall not be misrepresented as the original profile."

Le fichier vendorisé ici est **non modifié** (copie binaire identique au fichier téléchargé), ce qui est requis par la seconde phrase de la licence.

## Usage dans le monorepo

Ce fichier sert de **référence de provenance** uniquement. Le code source de `@factelec/invoice-core` n'effectue aucune lecture de fichier à l'exécution (contrainte de pureté de `src/`) : l'octet-array est encodé en base64 dans `packages/invoice-core/src/facturx/srgb-icc.ts`, généré depuis ce fichier via :

```bash
node -e "const fs=require('fs');const b=fs.readFileSync('docs/reference/icc/sRGB2014.icc').toString('base64');fs.writeFileSync('packages/invoice-core/src/facturx/srgb-icc.ts','// Généré depuis docs/reference/icc/sRGB2014.icc — ne pas éditer à la main.\\nexport const SRGB_ICC_BASE64 =\\n  \\''+b+'\\'\\n')"
```

Un test (`tests/facturx/generate.test.ts`) compare la constante `SRGB_ICC_BASE64` au contenu de ce fichier (relu en base64) afin de garantir l'intégrité et la traçabilité de la provenance à chaque exécution de la suite.
