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
    // Socle obligatoire G7.44 = {200, 210, 212, 213} — confirmé par
    // XP Z12-014 §4.2.1 p. 14 (« Déposée », « Rejetée », « Refusée »,
    // « Encaissée » obligatoirement transmis au CdD PPF).
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

describe('matrice CDV normative (AFNOR XP Z12-012 §5.1.1/5.3 + XP Z12-014 §4.2/4.3, extraits 2026-07-19)', () => {
  it('CORRIGE les 4 anomalies du monotone (BLOQUEUR 2.1) — toujours satisfaites', () => {
    // interdit 212→213 (mandat dur ledger 2.1, maintenu)
    expect(canTransition('encaissee', 'rejetee')).toBe(false)
    // retours légitimes que le monotone rejetait
    expect(canTransition('en_litige', 'approuvee')).toBe(true) // 207→205
    expect(canTransition('suspendue', 'prise_en_charge')).toBe(true) // 208→204
    expect(canTransition('approuvee_partiellement', 'approuvee')).toBe(true) // 206→205
  })

  it('terminaux DE DROIT = {refusee(210), rejetee(213)} — « ne peut pas être suivi d’un autre statut » (XP Z12-014 §4.3.1 p. 22)', () => {
    for (const t of ['refusee', 'rejetee'] as const) {
      expect(isTerminal(t)).toBe(true)
      expect(ALLOWED_TRANSITIONS[t]).toEqual([])
    }
    // Encaissée n'est PLUS terminale : encaissements partiels successifs
    // (XP Z12-014 §4.2.1 p. 18 « à chaque encaissement partiel ou total »).
    expect(isTerminal('encaissee')).toBe(false)
  })

  it('backbone chronologique préservé (dépôt → traitement → approbation → paiement)', () => {
    expect(canTransition('deposee', 'prise_en_charge')).toBe(true) // saut de facultatifs
    expect(canTransition('prise_en_charge', 'approuvee')).toBe(true)
    expect(canTransition('completee', 'encaissee')).toBe(true)
    expect(canTransition('deposee', 'rejetee')).toBe(true) // rejet en réception encore possible
  })

  // ORACLE INDÉPENDANT (revue T1, MEDIUM anti-tautologie) : cette table est
  // RETRANSCRITE À LA MAIN depuis les extraits primaires des normes AFNOR
  // XP Z12-012 (juillet 2025) et XP Z12-014 (juillet 2025), ré-extraits des
  // PDF le 2026-07-19 (leçon B1) — elle ne DOIT PAS être dérivée
  // d'ALLOWED_TRANSITIONS, sinon une typo de la table de prod passerait
  // inaperçue (canTransition ≡ la table). Modèle normatif traduit :
  //   - transmission « dans cet ordre » (014 §4.2.1 p. 14), sauts autorisés
  //     (statuts facultatifs), `rejetee` = alternative exclusive au succès
  //     des contrôles (jamais après Reçue — p. 15-16) ;
  //   - traitement « posés de façon indépendante » (p. 14) → maillage
  //     complet des 7 statuts de traitement + refusee + encaissee ;
  //   - refusee/rejetee sans sortie (p. 22) ;
  //   - encaissee : self-loop partiels (p. 18) + paiement_transmis (solde).
  const TRANSMISSION_DOWNSTREAM: Record<string, readonly string[]> = {
    deposee: ['emise', 'recue', 'mise_a_disposition'],
    emise: ['recue', 'mise_a_disposition'],
    recue: ['mise_a_disposition'],
    mise_a_disposition: [],
  }
  const PROCESSING = [
    'prise_en_charge',
    'approuvee',
    'approuvee_partiellement',
    'en_litige',
    'suspendue',
    'completee',
    'paiement_transmis',
  ] as const
  const EXPECTED_TRANSITIONS: Record<string, readonly string[]> = {
    // Transmission : aval de l'ordre normatif + tout le traitement +
    // encaissee + refusee (+ rejetee tant qu'un contrôle peut échouer).
    deposee: [
      ...TRANSMISSION_DOWNSTREAM.deposee!,
      ...PROCESSING,
      'encaissee',
      'refusee',
      'rejetee',
    ],
    emise: [
      ...TRANSMISSION_DOWNSTREAM.emise!,
      ...PROCESSING,
      'encaissee',
      'refusee',
      'rejetee',
    ],
    // Reçue = contrôles de réception RÉUSSIS → plus jamais de rejetee
    // (alternatives exclusives, XP Z12-014 p. 15-16).
    recue: [
      ...TRANSMISSION_DOWNSTREAM.recue!,
      ...PROCESSING,
      'encaissee',
      'refusee',
    ],
    mise_a_disposition: [...PROCESSING, 'encaissee', 'refusee'],
    // Traitement : indépendance totale entre statuts de traitement.
    prise_en_charge: [
      ...PROCESSING.filter((s) => s !== 'prise_en_charge'),
      'encaissee',
      'refusee',
    ],
    approuvee: [
      ...PROCESSING.filter((s) => s !== 'approuvee'),
      'encaissee', // Paiement Transmis « recommandé » = optionnel (§4.2.1 ét. 5)
      'refusee',
    ],
    approuvee_partiellement: [
      ...PROCESSING.filter((s) => s !== 'approuvee_partiellement'),
      'encaissee',
      'refusee',
    ],
    en_litige: [
      ...PROCESSING.filter((s) => s !== 'en_litige'),
      'encaissee',
      'refusee',
    ],
    suspendue: [
      ...PROCESSING.filter((s) => s !== 'suspendue'),
      'encaissee',
      'refusee',
    ],
    completee: [
      ...PROCESSING.filter((s) => s !== 'completee'),
      'encaissee',
      'refusee',
    ],
    paiement_transmis: [
      ...PROCESSING.filter((s) => s !== 'paiement_transmis'),
      'encaissee',
      'refusee',
    ],
    encaissee: ['encaissee', 'paiement_transmis'],
    refusee: [],
    rejetee: [],
  }

  it('la table de prod correspond EXACTEMENT à l’oracle indépendant (anti-tautologie)', () => {
    // Comparaison ensembliste par statut : toute arête ajoutée/retirée/typotée
    // dans ALLOWED_TRANSITIONS diverge de l’oracle retranscrit de la norme.
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

  it('interdit les self-loops pour tous les statuts SAUF encaissee (partiels, §4.2.1 p. 18)', () => {
    for (const s of LIFECYCLE_STATUSES) {
      expect(canTransition(s, s)).toBe(s === 'encaissee')
    }
  })

  it('jamais de retour du traitement vers la transmission (« dans cet ordre », §4.2.1 p. 14)', () => {
    const transmission = [
      'deposee',
      'emise',
      'recue',
      'mise_a_disposition',
    ] as const
    for (const from of [...PROCESSING, 'encaissee'] as const) {
      for (const to of transmission) {
        expect(canTransition(from, to)).toBe(false)
      }
    }
  })

  it('rejetee IMPOSSIBLE après Reçue (alternatives exclusives, §4.2/4.3 p. 15-16 et 20)', () => {
    expect(canTransition('recue', 'rejetee')).toBe(false)
    expect(canTransition('mise_a_disposition', 'rejetee')).toBe(false)
    for (const from of PROCESSING) {
      expect(canTransition(from, 'rejetee')).toBe(false)
    }
    // …mais encore possible tant que les contrôles de réception n'ont pas
    // réussi (rejet en réception par la PDP-R) :
    expect(canTransition('deposee', 'rejetee')).toBe(true)
    expect(canTransition('emise', 'rejetee')).toBe(true)
  })

  it('interdit les transitions absurdes (garde Object.hasOwn, aucune traversée prototype)', () => {
    expect(canTransition('encaissee', 'deposee')).toBe(false) // retour arrière
    expect(() => assertTransition('encaissee', 'rejetee')).toThrow(
      InvalidLifecycleTransitionError,
    )
    // @ts-expect-error entrée non fiable
    expect(canTransition('toString', 'deposee')).toBe(false)
  })

  it('motif requis : refusee, rejetee, en_litige (XP Z12-014) et suspendue (G7.25)', () => {
    // refusee : « DOIT TOUJOURS être accompagné d'un motif » (§4.3.1 p. 21)
    expect(requiresReason('refusee')).toBe(true)
    // rejetee : « auquel un motif doit être donné » (§4.2.2 p. 18, §4.3 p. 20)
    expect(requiresReason('rejetee')).toBe(true)
    // en_litige : « avec un motif, obligatoire » (§4.3.2/§4.3.3 ét. 4a)
    expect(requiresReason('en_litige')).toBe(true)
    // suspendue : G7.25 (Annexe 7 DGFiP), non infirmé par la norme
    expect(requiresReason('suspendue')).toBe(true)
    expect(requiresReason('approuvee')).toBe(false)
  })

  // Arêtes normatives NOUVELLES du swap — chacune assertée explicitement
  // avec son ancrage, aller ET (le cas échéant) sens interdit.
  it('208→209 : suspendue → completee (réponse du VENDEUR, §4.2.1 ét. 4c)', () => {
    expect(canTransition('suspendue', 'completee')).toBe(true)
  })

  it('205→212 : approuvee → encaissee direct (Paiement Transmis optionnel, §4.2.1 ét. 5)', () => {
    expect(canTransition('approuvee', 'encaissee')).toBe(true)
  })

  it('212→212 et 212→211 : encaissements partiels puis solde (§4.2.1 p. 18)', () => {
    expect(canTransition('encaissee', 'encaissee')).toBe(true)
    expect(canTransition('encaissee', 'paiement_transmis')).toBe(true)
    // le mandat dur ¬(212→213) et la fermeture du reste tiennent toujours
    expect(canTransition('encaissee', 'rejetee')).toBe(false)
    expect(canTransition('encaissee', 'approuvee')).toBe(false)
    expect(canTransition('encaissee', 'en_litige')).toBe(false)
    expect(canTransition('encaissee', 'refusee')).toBe(false)
  })

  it('203→205 : approbation directe sans prise en charge (indépendance, §4.2.1 p. 14)', () => {
    expect(canTransition('mise_a_disposition', 'approuvee')).toBe(true)
    expect(canTransition('mise_a_disposition', 'en_litige')).toBe(true)
    expect(canTransition('mise_a_disposition', 'suspendue')).toBe(true)
  })

  // Les 3 « retours restaurés » du ledger 2.1, désormais couverts par
  // l'indépendance normative des statuts de traitement.
  it('207→205 : en_litige → approuvee (dispute résolue → approbation)', () => {
    expect(canTransition('en_litige', 'approuvee')).toBe(true)
  })

  it('208→204 : suspendue → prise_en_charge (suspension levée → reprise)', () => {
    expect(canTransition('suspendue', 'prise_en_charge')).toBe(true)
  })

  it('206→205 : approuvee_partiellement → approuvee (partielle → totale)', () => {
    expect(canTransition('approuvee_partiellement', 'approuvee')).toBe(true)
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

  it('requiresReason is false for every other status (exhaustive)', () => {
    const withReason = new Set(['refusee', 'rejetee', 'en_litige', 'suspendue'])
    for (const status of LIFECYCLE_STATUSES) {
      expect(requiresReason(status)).toBe(withReason.has(status))
    }
  })

  it('TERMINAL_STATUSES = {refusee, rejetee} matches isTerminal exhaustively', () => {
    for (const status of LIFECYCLE_STATUSES) {
      expect(isTerminal(status)).toBe(
        status === 'refusee' || status === 'rejetee',
      )
    }
  })
})
