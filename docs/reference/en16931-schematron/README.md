# Schematron EN 16931 (validation métier officielle)

Artefacts de validation Schematron pour la norme EN 16931, dépôt officiel
CEN/TC 434 : https://github.com/ConnectingEurope/eInvoicing-EN16931

- Release : `validation-1.3.16` (publiée 2026-04-13).
- Asset : `en16931-ubl-1.3.16.zip`.
- sha256 : `bafada015efbc5248bf5e05ad2191e1d9833ef96e9dd5f4bce420a747342da85`.
- Licence : EUPL 1.2.

`1.3.16/xslt/EN16931-UBL-validation.xslt` est le Schematron pré-compilé en XSLT 2.0
(auto-porteur). Il est compilé en SEF (saxon-js) au lancement des tests puis exécuté
en Node pur (aucune JVM) pour produire un rapport SVRL. Toute assertion en échec
(`svrl:failed-assert`) rend le test rouge. Ne jamais modifier ces fichiers ; pour
changer de version, ajouter un nouveau sous-dossier `<version>/` et son entrée ici.
