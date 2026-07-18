import { NotFoundException } from '@nestjs/common'
import { ProblemType, problem } from '../common/problem.js'

// Fabrique 404 PARTAGÉE du domaine ereporting (plan 3.4, Task 2 — relogée
// ici depuis ereporting.controller.ts, revue T2 N-1 : le service de
// retransmission l'importait DU contrôleur, dépendance inversée fragile ;
// module neutre = contrôleur ET service dépendent tous deux du domaine).
// Un seul body 404 pour TOUT le domaine — anti-fuite d'existence
// (transmission inconnue, cross-tenant, déclarant inconnu : indiscernables ;
// la précision du wording cède devant l'anti-fuite, nit revue du plan acté).
export function ereportingNotFound(): NotFoundException {
  return new NotFoundException(
    problem(404, ProblemType.notFound, 'Unknown transmission'),
  )
}
