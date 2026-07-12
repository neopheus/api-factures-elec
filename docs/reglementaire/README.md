# Documentation réglementaire — facturation électronique

Documents officiels téléchargés le 2026-07-12 depuis impots.gouv.fr et OpenPeppol.
Ils constituent la référence pour le développement de la plateforme agréée (PA/PDP)
et pour le dossier d'immatriculation DGFiP.

## Immatriculation plateforme agréée

Source : https://www.impots.gouv.fr/facturation-electronique-et-plateformes-agreees

| Fichier | Contenu |
|---|---|
| `guide_utilisateur_fe_ds_immatriculation_pdp.pdf` | Guide d'immatriculation — procédure de dépôt du dossier sur demarche.numerique.gouv.fr |
| `liste-des-documents-a-fournir-pour-devenir-une-pdp.pdf` | Liste des pièces requises pour le dossier |
| `fe-plateforme_agree-reglement_et_charte.pdf` | Règlement et charte des plateformes agréées |
| `fe_charte-utilisation-logotype-solution-compatible.pdf` | Charte d'utilisation de la marque / logotype |
| `faq---plateformes_de_dematerialisation-v16102024.pdf` | FAQ plateformes de dématérialisation |
| `circuit-de-transmission-des-factures-et-des-donnees.pdf` | Schéma du circuit de transmission (schéma en Y) |

## Peppol

Source : https://www.impots.gouv.fr/rejoindre-le-reseau-peppol

| Fichier | Contenu |
|---|---|
| `peppol-onboarding-accreditation-service-providers.pdf` | Procédure OpenPeppol d'onboarding et d'accréditation des service providers |

La convention avec l'Autorité Peppol française se récupère/signe via :
https://demarche.numerique.gouv.fr/commencer/peppolfrance

## Spécifications externes v3.2 (le référentiel technique)

Source : https://www.impots.gouv.fr/specifications-externes-b2b
Répertoire : `specifications-externes-v3.2/`

| Élément | Contenu |
|---|---|
| `0- Dossier de specifications externes FE - Dossier général_v3.2.pdf` | Dossier général : flux, cas d'usage, cycle de vie, obligations des PA |
| `1- Dossier de spécifications externes FE - Chorus Pro_v1.1.pdf` | Spécificités B2G / Chorus Pro |
| `2- Annexes_v3.2/` | Formats sémantiques (xlsx) : e-invoicing (flux 1), cycle de vie (flux 6), annuaire, e-reporting, règles de gestion |
| `3- XSD_v3.2/` | Schémas XSD officiels : e-reporting, annuaire (F12-F14), e-invoicing UBL 2.1 (BASE/FULL), CII D22B |
| `4- Swagger_v3.2/ppf-openapi-annuaire-api-public-1.11.0-openapi.json` | OpenAPI de l'API publique de l'annuaire |

Ces XSD et ce swagger sont à utiliser directement dans `invoice-core` et les modules
annuaire/e-reporting (validation, génération de types, golden files de tests).

Note : seule la dernière version (v3.2) est archivée ici ; les versions antérieures
(v1.x → v3.1) restent disponibles sur la page source si besoin d'historique.
