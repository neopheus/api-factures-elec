# XSD UN/CEFACT CII D16B (SCRDM Subset — Coupled Code List Modules)

Schémas XSD officiels UN/CEFACT « Cross Industry Invoice » D16B, dans leur variante
« Coupled Code List Modules » (CLM), vendorisés depuis le dépôt CEN/TC 434 :
https://github.com/ConnectingEurope/eInvoicing-EN16931

- Dépôt : `ConnectingEurope/eInvoicing-EN16931`.
- Tag : `validation-1.3.16`.
- Sous-arbre extrait : `cii/schema/D16B SCRDM (Subset)/coupled clm/CII/uncefact/`
  (racine `data/standard/`, imports `codelist/standard/` et `identifierlist/standard/`).
- sha256 du tarball GitHub (`gh api repos/.../tarball/refs/tags/validation-1.3.16`) :
  `ace5d0a022755841db3692a44557e804a26571d902e8742498fba605c506be72`.
- Licence : UN/CEFACT — permissive, cf. en-tête de chaque XSD (« Copyright (C)
  UN/CEFACT (2016). All Rights Reserved. [...] may be copied and furnished to
  others [...] without restriction of any kind [...] this document itself may
  not be modified in any way »). Fichiers vendorisés tels quels, non modifiés.

## Fichier racine

`uncefact/data/standard/CrossIndustryInvoice_100pD16B.xsd` — importe (dans le
même dossier) `CrossIndustryInvoice_QualifiedDataType_100pD16B.xsd` (qdt),
`CrossIndustryInvoice_ReusableAggregateBusinessInformationEntity_100pD16B.xsd`
(ram) et `CrossIndustryInvoice_UnqualifiedDataType_100pD16B.xsd` (udt). Le
module qdt importe à son tour ~50 listes de codes UNECE/ISO/EDIFICAS sous
`uncefact/codelist/standard/` et `uncefact/identifierlist/standard/` — la
structure de dossiers d'origine (`data/standard`, `codelist/standard`,
`identifierlist/standard`, tous sous `uncefact/`) est donc conservée intacte
pour préserver les chemins `schemaLocation` relatifs (`../../codelist/standard/...`).

Ne jamais modifier ces fichiers ; pour changer de version, ajouter un nouveau
sous-dossier de version et son entrée ici.
