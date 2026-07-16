import {
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { ProblemType, problem } from '../common/problem.js'
import { parseQuery } from '../common/validation.js'
// biome-ignore lint/style/useImportType: AnnuaireConsultationService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { AnnuaireConsultationService } from './annuaire-consultation.service.js'
import {
  lignesQuerySchema,
  resolutionQuerySchema,
} from './annuaire-query.schema.js'
import {
  AmbiguousResolutionError,
  type Maille,
  RecipientUnaddressableError,
} from './ligne-adressage.js'

// Consultation annuaire (Task 7, plan 2.4) — dual-auth (`TenantAuthGuard` :
// clé API OU session, jamais admin — motif `EreportingController`, 2.3
// Task 9). Surface de LECTURE SEULE sur le miroir tenant-scopé (alimenté par
// la sync Flux 14, Task 9) et sur la résolution de routage (Task 2) — la
// brique que le futur routage d'émission consommera (câblage différé,
// périmètre 2.4).
@Controller('annuaire')
export class AnnuaireController {
  constructor(private readonly consultation: AnnuaireConsultationService) {}

  // Recherche dans le miroir de consultation, filtrée par SIREN (RLS fait
  // déjà toute l'isolation tenant côté repository — aucun autre tenant
  // n'apparaît jamais dans le résultat, quel que soit le SIREN demandé).
  @Get('lignes')
  @UseGuards(TenantAuthGuard)
  async lignes(@CurrentTenant() tenantId: string, @Query() query: unknown) {
    const { siren } = parseQuery(lignesQuerySchema, query)
    const lignes = await this.consultation.listDirectoryEntries(tenantId, siren)
    return { lignes }
  }

  // Résolution du matricule de plateforme destinataire pour une maille à
  // une date donnée. 404 ANTI-FUITE BYTE-IDENTIQUE (motif
  // `LedgerController`/`EreportingController`) que le destinataire soit
  // réellement inconnu du miroir, hors période d'effet, OU d'un AUTRE
  // tenant (RLS) — les trois cas sont indiscernables côté HTTP.
  @Get('resolution')
  @UseGuards(TenantAuthGuard)
  async resolution(@CurrentTenant() tenantId: string, @Query() query: unknown) {
    const parsed = parseQuery(resolutionQuerySchema, query)
    const maille: Maille = {
      siren: parsed.siren,
      siret: parsed.siret,
      routageId: parsed.routageId,
      suffixe: parsed.suffixe,
    }
    try {
      return await this.consultation.resolveRecipient(
        tenantId,
        maille,
        parsed.date,
      )
    } catch (err) {
      if (err instanceof RecipientUnaddressableError) {
        throw new NotFoundException(
          problem(404, ProblemType.notFound, 'Unknown recipient'),
        )
      }
      if (err instanceof AmbiguousResolutionError) {
        // 409 documenté (injection revue T2 #4/#5) : signale une résolution
        // indéterminée SANS jamais exposer les plateformes concurrentes —
        // `AmbiguousResolutionError` elle-même n'en porte aucune
        // (ligne-adressage.ts), le `detail` ci-dessous ne révèle donc rien
        // de plus que « ambigu ».
        throw new ConflictException(
          problem(409, ProblemType.conflict, 'Ambiguous routing resolution', {
            detail:
              'La résolution de routage est indéterminée pour cette maille à cette date (lignes concurrentes non départagées).',
          }),
        )
      }
      throw err
    }
  }
}
