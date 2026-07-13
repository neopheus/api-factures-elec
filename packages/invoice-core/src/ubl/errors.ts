// `generateUbl` route désormais 380 (Invoice) et 381 (CreditNote, via
// generate-credit-note.ts) : cette erreur n'est plus levée par les générateurs.
// Elle reste exportée comme type d'erreur public, réservé à la frontière API
// (plan 1.3) pour rejeter un typeCode hors périmètre du socle avant génération.
export class UnsupportedTypeCodeError extends Error {
  readonly typeCode: string
  constructor(typeCode: string) {
    super(
      `Génération UBL non supportée pour le typeCode ${typeCode} ` +
        '(seuls 380 - facture et 381 - avoir sont pris en charge).',
    )
    this.name = 'UnsupportedTypeCodeError'
    this.typeCode = typeCode
  }
}
