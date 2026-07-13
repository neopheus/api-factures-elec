// cbc:ProfileID (BT-23 « Cadre de Facturation ») est structurellement obligatoire
// dans les extraits de flux F1 et sa valeur sémantique est prescrite par la règle
// de gestion DGFiP G1.02 (Annexe 7 v1.9). Émettre un extrait sans cette information
// produirait un ProfileID inventé et invalide : on refuse explicitement plutôt que
// de laisser passer une valeur non conforme.
export class MissingBusinessProcessTypeError extends Error {
  constructor() {
    super(
      'businessProcessType (BT-23, cadre de facturation) est obligatoire pour ' +
        'émettre un extrait de flux F1 : la règle de gestion DGFiP G1.02 (Annexe 7 v1.9) ' +
        'impose une valeur parmi B1, S1, M1, B2, S2, M2, B4, S4, M4, S5, S6, B7, S7.',
    )
    this.name = 'MissingBusinessProcessTypeError'
  }
}
