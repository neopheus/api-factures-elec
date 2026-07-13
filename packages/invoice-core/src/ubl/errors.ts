// La génération UBL CreditNote (typeCode 381) est livrée au plan 1.2bis.
// D'ici là, toute tentative d'émettre un avoir échoue de façon explicite
// plutôt que de produire un document UBL Invoice sémantiquement faux.
export class UnsupportedTypeCodeError extends Error {
  readonly typeCode: string
  constructor(typeCode: string) {
    super(
      `Génération UBL non supportée pour le typeCode ${typeCode} ` +
        "(seule la facture 380 est émise en 1.2 ; l'avoir 381 arrive au plan 1.2bis).",
    )
    this.name = 'UnsupportedTypeCodeError'
    this.typeCode = typeCode
  }
}
