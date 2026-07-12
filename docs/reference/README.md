# Références normatives vendorisées

## ubl-2.1/

XSD officiels OASIS UBL 2.1 (os-UBL-2.1), téléchargés le 2026-07-12 depuis
https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.zip — `maindoc/UBL-Invoice-2.1.xsd`,
`maindoc/UBL-CreditNote-2.1.xsd` et leurs imports `common/`. Ne jamais les modifier.

C'est la cible de validation structurelle de `generateUbl` (facture commerciale
EN 16931 complète). Les profils DGFiP F1 BASE/FULL
(`docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/`) sont des
**restrictions fiscales de flux** : leurs composants communs désactivent notamment
`PartyName`, `RegistrationName`, `TaxInclusiveAmount` et `PayableAmount` (vérifié le
2026-07-12 après strip des commentaires XML). Ils serviront d'objectif de validation
aux émetteurs d'extraits de flux dédiés (plan 1.2), dérivés du même modèle canonique.
