import { describe, expect, it } from 'vitest'
import {
  ANNUAIRE_STATUS_META,
  type AnnuaireLigneStatus,
  assertTransition,
  canTransition,
  InvalidAnnuaireTransitionError,
  isAnnuaireLigneStatus,
  isTerminal,
  motifRequired,
} from '../../src/annuaire/annuaire-lifecycle.js'

const ALL_STATUSES: AnnuaireLigneStatus[] = [
  'draft',
  'published',
  'deposee',
  'rejetee',
  'masked',
]

// Matrice complète des transitions autorisées — seule source de vérité du
// test (miroir du tableau ALLOWED de l'implémentation, décrit indépendamment
// pour ne pas simplement réciter le code).
const EXPECTED_ALLOWED: Record<AnnuaireLigneStatus, AnnuaireLigneStatus[]> = {
  draft: ['published'],
  published: ['deposee', 'rejetee'],
  deposee: ['masked'],
  rejetee: [],
  masked: [],
}

describe('machine à états publication annuaire (draft→published→déposée/rejetée, masquage)', () => {
  it('ancre code:null sur tous les statuts (aucun code réglementaire DGFiP pour l’annuaire)', () => {
    // Aucun « Tableau » de codes officiels n'existe pour l'annuaire
    // (contrairement au 300/301 e-reporting) — leçon 2.3-A3 : ne jamais
    // inventer un faux code réglementaire pour un état interne PA.
    for (const status of ALL_STATUSES) {
      expect(ANNUAIRE_STATUS_META[status].code).toBeNull()
    }
  })

  it('autorise draft→published, published→deposee, published→rejetee, deposee→masked', () => {
    expect(canTransition('draft', 'published')).toBe(true)
    expect(canTransition('published', 'deposee')).toBe(true)
    expect(canTransition('published', 'rejetee')).toBe(true)
    expect(canTransition('deposee', 'masked')).toBe(true)
  })

  it('matrice complète : chaque transition possible (25 = 5×5) est vérifiée dans les deux sens (autorisée / interdite)', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = EXPECTED_ALLOWED[from].includes(to)
        expect(canTransition(from, to)).toBe(expected)
      }
    }
  })

  it('interdit toutes les auto-transitions (aucun statut ne se boucle sur lui-même)', () => {
    for (const status of ALL_STATUSES) {
      expect(canTransition(status, status)).toBe(false)
    }
  })

  it('interdit les sauts d’étape (draft→deposee, draft→rejetee, draft→masked, published→masked)', () => {
    expect(canTransition('draft', 'deposee')).toBe(false)
    expect(canTransition('draft', 'rejetee')).toBe(false)
    expect(canTransition('draft', 'masked')).toBe(false)
    expect(canTransition('published', 'masked')).toBe(false)
  })

  it('interdit tout retour en arrière (published→draft, deposee→published, rejetee→published, masked→deposee)', () => {
    expect(canTransition('published', 'draft')).toBe(false)
    expect(canTransition('deposee', 'published')).toBe(false)
    expect(canTransition('rejetee', 'published')).toBe(false)
    expect(canTransition('masked', 'deposee')).toBe(false)
  })

  it('terminaux : rejetee et masked sont terminaux ; draft/published/deposee ne le sont pas (A-DEADLOCK)', () => {
    expect(isTerminal('rejetee')).toBe(true)
    expect(isTerminal('masked')).toBe(true)
    expect(isTerminal('draft')).toBe(false)
    expect(isTerminal('published')).toBe(false)
    // deposee n'est PAS terminal : une ligne déposée peut être masquée
    // (A-DEADLOCK, revue 2.4) — c'est le point structurant distinguant cette
    // machine du miroir e-reporting où deposee/rejetee sont TOUS deux
    // terminaux.
    expect(isTerminal('deposee')).toBe(false)
  })

  it('aucune transition ne sort d’un statut terminal (rejetee et masked n’ont aucune cible autorisée)', () => {
    for (const to of ALL_STATUSES) {
      expect(canTransition('rejetee', to)).toBe(false)
      expect(canTransition('masked', to)).toBe(false)
    }
  })

  it('exige un motif pour rejetee uniquement (chaîne libre, D6) — pas pour masked/deposee/draft/published', () => {
    expect(motifRequired('rejetee')).toBe(true)
    expect(motifRequired('deposee')).toBe(false)
    expect(motifRequired('draft')).toBe(false)
    expect(motifRequired('published')).toBe(false)
    expect(motifRequired('masked')).toBe(false)
  })

  it('assertTransition lève InvalidAnnuaireTransitionError sur une transition invalide, avec from/to portés', () => {
    expect(() => assertTransition('draft', 'deposee')).toThrow(
      InvalidAnnuaireTransitionError,
    )
    let caught: unknown
    try {
      assertTransition('rejetee', 'published')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(InvalidAnnuaireTransitionError)
    expect((caught as InvalidAnnuaireTransitionError).from).toBe('rejetee')
    expect((caught as InvalidAnnuaireTransitionError).to).toBe('published')
    expect((caught as Error).message).toBe(
      'invalid annuaire transition: rejetee → published',
    )
  })

  it('assertTransition ne lève pas sur une transition valide', () => {
    expect(() => assertTransition('draft', 'published')).not.toThrow()
    expect(() => assertTransition('published', 'deposee')).not.toThrow()
    expect(() => assertTransition('published', 'rejetee')).not.toThrow()
    expect(() => assertTransition('deposee', 'masked')).not.toThrow()
  })

  it('isAnnuaireLigneStatus reconnaît les 5 slugs valides et rejette le reste (garde anti-prototype)', () => {
    for (const status of ALL_STATUSES) {
      expect(isAnnuaireLigneStatus(status)).toBe(true)
    }
    expect(isAnnuaireLigneStatus('unknown')).toBe(false)
    // Garde anti-prototype (Object.hasOwn, pas `in`) : ces slugs existent sur
    // Object.prototype et seraient reconnus à tort par `v in META`.
    expect(isAnnuaireLigneStatus('toString')).toBe(false)
    expect(isAnnuaireLigneStatus('constructor')).toBe(false)
    expect(isAnnuaireLigneStatus('hasOwnProperty')).toBe(false)
    expect(isAnnuaireLigneStatus(42)).toBe(false)
    expect(isAnnuaireLigneStatus(undefined)).toBe(false)
    expect(isAnnuaireLigneStatus(null)).toBe(false)
  })
})
