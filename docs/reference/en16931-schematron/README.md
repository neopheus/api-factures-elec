# Schematron EN 16931 (validation métier officielle)

Artefacts de validation Schematron pour la norme EN 16931, dépôt officiel
CEN/TC 434 : https://github.com/ConnectingEurope/eInvoicing-EN16931

- Release : `validation-1.3.16` (publiée 2026-04-13).
- Asset UBL : `en16931-ubl-1.3.16.zip`.
- sha256 : `bafada015efbc5248bf5e05ad2191e1d9833ef96e9dd5f4bce420a747342da85`.
- Licence : EUPL 1.2.
- Asset CII : `en16931-cii-1.3.16.zip` (même release `validation-1.3.16`).
- sha256 : `1cd53cb8a84d38aedc82c0caede217da983a7934dd663f793a092fd66443c561`.
- Licence : EUPL 1.2.

`1.3.16/xslt/EN16931-UBL-validation.xslt` et `1.3.16/xslt/EN16931-CII-validation.xslt`
sont les Schematron pré-compilés en XSLT 2.0 (auto-porteurs), un par syntaxe. Ils sont
compilés en SEF (saxon-js) au lancement des tests puis exécutés en Node pur (aucune
JVM) pour produire un rapport SVRL. Toute assertion en échec (`svrl:failed-assert`)
rend le test rouge. `1.3.16/schematron/codelist/EN16931-CII-codes.sch` fournit la
liste des codes VATEX (motifs d'exonération, tâche 6) pour la syntaxe CII. Ne jamais
modifier ces fichiers ; pour changer de version, ajouter un nouveau sous-dossier
`<version>/` et son entrée ici.
