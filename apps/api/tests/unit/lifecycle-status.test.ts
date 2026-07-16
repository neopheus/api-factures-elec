import { describe, expect, it } from 'vitest'
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
  INITIAL_STATUS,
  InvalidLifecycleTransitionError,
  isLifecycleStatus,
  isTerminal,
  LIFECYCLE_STATUSES,
  requiresReason,
  STATUS_META,
  statusByCode,
} from '../../src/invoices/lifecycle-status.js'

describe('lifecycle-status (CDV state machine)', () => {
  it('exposes the 14 DGFiP statuses with codes 200..213', () => {
    expect(LIFECYCLE_STATUSES).toHaveLength(14)
    expect(STATUS_META.deposee).toEqual({
      code: 200,
      label: 'Déposée',
      mandatory: true,
    })
    expect(STATUS_META.refusee.code).toBe(210)
    expect(STATUS_META.encaissee).toEqual({
      code: 212,
      label: 'Encaissée',
      mandatory: true,
    })
    expect(STATUS_META.rejetee.code).toBe(213)
    // Socle obligatoire G7.44 = {200, 210, 212, 213}
    const mandatory = LIFECYCLE_STATUSES.filter((s) => STATUS_META[s].mandatory)
      .map((s) => STATUS_META[s].code)
      .sort((a, b) => a - b)
    expect(mandatory).toEqual([200, 210, 212, 213])
  })

  it('starts at Déposée (200)', () => {
    expect(INITIAL_STATUS).toBe('deposee')
    expect(STATUS_META[INITIAL_STATUS].code).toBe(200)
  })
})

describe('matrice CDV DAG (INTERPRÉTATION PROJET / AFNOR XP Z12-012 ; §3.6.4 Tableau 8)', () => {
  it('CORRIGE les 4 anomalies du monotone (BLOQUEUR 2.1)', () => {
    // interdit 212→213 (encaissée terminale — chemin heureux clos)
    expect(canTransition('encaissee', 'rejetee')).toBe(false)
    // autorise les retours légitimes que le monotone rejetait
    expect(canTransition('en_litige', 'approuvee')).toBe(true) // 207→205
    expect(canTransition('suspendue', 'prise_en_charge')).toBe(true) // 208→204
    expect(canTransition('approuvee_partiellement', 'approuvee')).toBe(true) // 206→205
  })

  it('terminaux = {refusee(210), encaissee(212), rejetee(213)} — aucune sortie', () => {
    for (const t of ['refusee', 'encaissee', 'rejetee'] as const) {
      expect(isTerminal(t)).toBe(true)
      expect(ALLOWED_TRANSITIONS[t]).toEqual([])
    }
  })

  it('backbone chronologique préservé (dépôt → traitement → approbation → paiement)', () => {
    expect(canTransition('deposee', 'prise_en_charge')).toBe(true) // saut de facultatifs
    expect(canTransition('prise_en_charge', 'approuvee')).toBe(true)
    expect(canTransition('completee', 'encaissee')).toBe(true)
    expect(canTransition('deposee', 'rejetee')).toBe(true) // contrôle au dépôt
  })

  // ORACLE INDÉPENDANT (revue T1, MEDIUM anti-tautologie) : cette table est
  // RETRANSCRITE À LA MAIN depuis la table du plan 3.1 (elle-même vérifiée
  // arête par arête contre l'Annexe 2 V2.3 / §3.6.4 par la revue du plan) —
  // elle ne DOIT PAS être dérivée d'ALLOWED_TRANSITIONS, sinon une typo de
  // la table de prod passerait inaperçue (canTransition ≡ la table). C'est
  // le filet du futur swap AFNOR XP Z12-012 : toute divergence table↔oracle
  // casse ici.
  const EXPECTED_TRANSITIONS: Record<string, readonly string[]> = {
    deposee: [
      'emise',
      'recue',
      'mise_a_disposition',
      'prise_en_charge',
      'refusee',
      'rejetee',
    ],
    emise: [
      'recue',
      'mise_a_disposition',
      'prise_en_charge',
      'refusee',
      'rejetee',
    ],
    recue: ['mise_a_disposition', 'prise_en_charge', 'refusee', 'rejetee'],
    mise_a_disposition: ['prise_en_charge', 'refusee', 'rejetee'],
    prise_en_charge: [
      'approuvee',
      'approuvee_partiellement',
      'en_litige',
      'suspendue',
      'completee',
      'refusee',
      'rejetee',
    ],
    approuvee: ['completee', 'paiement_transmis', 'en_litige', 'refusee'],
    approuvee_partiellement: [
      'approuvee', // 206→205 mandaté (ledger 2.1)
      'en_litige',
      'suspendue',
      'completee',
      'refusee',
      'rejetee',
    ],
    en_litige: [
      'approuvee', // 207→205 mandaté (ledger 2.1)
      'approuvee_partiellement',
      'prise_en_charge',
      'suspendue',
      'refusee',
    ],
    suspendue: [
      'prise_en_charge', // 208→204 mandaté (ledger 2.1)
      'approuvee',
      'approuvee_partiellement',
      'en_litige',
      'refusee',
    ],
    completee: ['paiement_transmis', 'encaissee', 'refusee'],
    paiement_transmis: ['encaissee'],
    refusee: [],
    encaissee: [], // 212 terminal → ¬(212→213) mandaté ; cf. bannière A3
    rejetee: [],
  }

  it('la table de prod correspond EXACTEMENT à l’oracle indépendant (anti-tautologie, filet AFNOR)', () => {
    // Comparaison ensembliste par statut : toute arête ajoutée/retirée/typotée
    // dans ALLOWED_TRANSITIONS diverge de l’oracle retranscrit du plan.
    for (const from of LIFECYCLE_STATUSES) {
      expect([...ALLOWED_TRANSITIONS[from]].sort()).toEqual(
        [...EXPECTED_TRANSITIONS[from]!].sort(),
      )
    }
    expect(Object.keys(EXPECTED_TRANSITIONS).sort()).toEqual(
      [...LIFECYCLE_STATUSES].sort(),
    )
  })

  it('autorise chaque arête de l’ORACLE et interdit tout le complément (14×14, les deux sens)', () => {
    for (const from of LIFECYCLE_STATUSES) {
      for (const to of LIFECYCLE_STATUSES) {
        const declared = EXPECTED_TRANSITIONS[from]!.includes(to)
        expect(canTransition(from, to)).toBe(declared)
      }
    }
  })

  it('interdit les self-loops pour tous les statuts', () => {
    for (const s of LIFECYCLE_STATUSES) {
      expect(canTransition(s, s)).toBe(false)
    }
  })

  it('interdit les transitions absurdes (garde Object.hasOwn, aucune traversée prototype)', () => {
    expect(canTransition('encaissee', 'deposee')).toBe(false) // retour arrière depuis terminal
    expect(() => assertTransition('encaissee', 'rejetee')).toThrow(
      InvalidLifecycleTransitionError,
    )
    // @ts-expect-error entrée non fiable
    expect(canTransition('toString', 'deposee')).toBe(false)
  })

  it('motif requis inchangé (G7.25) : refusee & suspendue', () => {
    expect(requiresReason('refusee')).toBe(true)
    expect(requiresReason('suspendue')).toBe(true)
    expect(requiresReason('approuvee')).toBe(false)
  })

  // Les 3 « retours restaurés » (business-logic + mandat ledger 2.1,
  // corrections dures, non normées AFNOR) — chacun asserté explicitement,
  // aller ET retour, pour prouver qu'ils sont bien atteignables dans le sens
  // documenté et interdits dans l'autre sens quand non déclarés.
  it('207→205 : en_litige → approuvee restauré (dispute résolue → approbation)', () => {
    expect(canTransition('en_litige', 'approuvee')).toBe(true)
  })

  it('208→204 : suspendue → prise_en_charge restauré (suspension levée → reprise)', () => {
    expect(canTransition('suspendue', 'prise_en_charge')).toBe(true)
  })

  it('206→205 : approuvee_partiellement → approuvee restauré (partielle → totale)', () => {
    expect(canTransition('approuvee_partiellement', 'approuvee')).toBe(true)
  })

  it('212 (encaissee) est intégralement terminal — interprétation stricte-que-le-mandat', () => {
    // Le mandat dur (ledger 2.1) n'exige que ¬(212→213). Ce projet va plus
    // loin et ferme TOUTE sortie de 212 (cf. bannière du module) : vérifié
    // ici sur un échantillon représentatif au-delà du seul 212→213.
    expect(canTransition('encaissee', 'rejetee')).toBe(false)
    expect(canTransition('encaissee', 'approuvee')).toBe(false)
    expect(canTransition('encaissee', 'en_litige')).toBe(false)
    expect(canTransition('encaissee', 'paiement_transmis')).toBe(false)
    expect(canTransition('encaissee', 'refusee')).toBe(false)
  })

  it('complétude : chaque statut non-terminal a au moins une arête sortante (pas d’état mort)', () => {
    for (const s of LIFECYCLE_STATUSES) {
      if (isTerminal(s)) continue
      expect(ALLOWED_TRANSITIONS[s].length).toBeGreaterThan(0)
    }
  })

  it('les 4 obligatoires {200,210,212,213} sont tous atteignables depuis deposee', () => {
    expect(canTransition('deposee', 'refusee')).toBe(true) // 200→210
    expect(canTransition('deposee', 'rejetee')).toBe(true) // 200→213
    // 212 atteignable via prise_en_charge → completee → encaissee
    expect(canTransition('prise_en_charge', 'completee')).toBe(true)
    expect(canTransition('completee', 'encaissee')).toBe(true)
  })
})

describe('lifecycle-status (contrat inchangé)', () => {
  it('assertTransition throws a typed error on an invalid transition', () => {
    expect(() => assertTransition('encaissee', 'deposee')).toThrow(
      InvalidLifecycleTransitionError,
    )
    expect(() => assertTransition('deposee', 'emise')).not.toThrow()
  })

  it('maps codes to slugs and guards unknown values', () => {
    expect(statusByCode(200)).toBe('deposee')
    expect(statusByCode(999)).toBeNull()
    expect(isLifecycleStatus('deposee')).toBe(true)
    expect(isLifecycleStatus('nope')).toBe(false)
  })

  // isLifecycleStatus() garde une entrée NON FIABLE (utilisée en aval par
  // Tasks 5/6 pour valider un statut reçu, ex. body de requête HTTP). `in`
  // traverse la chaîne de prototype : sans garde dédiée, ces noms hérités
  // d'Object.prototype seraient (à tort) reconnus comme des slugs valides,
  // faussant silencieusement canTransition/statusByCode en aval
  // (STATUS_META['toString'].code === undefined).
  it.each(['toString', 'constructor', 'hasOwnProperty', 'valueOf'])(
    'rejects prototype-chain property %s as an unknown status',
    (name) => {
      expect(isLifecycleStatus(name)).toBe(false)
    },
  )

  it('assertTransition throws with the from/to slugs attached', () => {
    let caught: unknown
    try {
      assertTransition('rejetee', 'deposee')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvalidLifecycleTransitionError)
    const typed = caught as InvalidLifecycleTransitionError
    expect(typed.from).toBe('rejetee')
    expect(typed.to).toBe('deposee')
    expect(typed.name).toBe('InvalidLifecycleTransitionError')
  })

  it('requiresReason is false for every other status (exhaustive sample)', () => {
    for (const status of LIFECYCLE_STATUSES) {
      if (status === 'refusee' || status === 'suspendue') continue
      expect(requiresReason(status)).toBe(false)
    }
  })

  it('TERMINAL_STATUSES (encaissee incluse) matches isTerminal exhaustively', () => {
    for (const status of LIFECYCLE_STATUSES) {
      expect(isTerminal(status)).toBe(
        status === 'refusee' || status === 'encaissee' || status === 'rejetee',
      )
    }
  })
})
