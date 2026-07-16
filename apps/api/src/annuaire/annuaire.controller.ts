import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { ProblemType, problem } from '../common/problem.js'
import { isUuid } from '../common/uuid.js'
import { parseBody, parseQuery } from '../common/validation.js'
import { LigneSlotConflictError } from './annuaire.repository.js'
// biome-ignore lint/style/useImportType: AnnuaireConsultationService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { AnnuaireConsultationService } from './annuaire-consultation.service.js'
import {
  endEffectBodySchema,
  publishLigneBodySchema,
} from './annuaire-publication.schema.js'
// biome-ignore lint/style/useImportType: AnnuairePublicationService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import {
  AnnuairePublicationService,
  ConsentRequiredError,
  InvalidLignePeriodError,
  StaleLigneTransitionError,
} from './annuaire-publication.service.js'
import {
  codesRoutageQuerySchema,
  lignesQuerySchema,
  resolutionQuerySchema,
} from './annuaire-query.schema.js'
import {
  AmbiguousResolutionError,
  type Maille,
  RecipientUnaddressableError,
} from './ligne-adressage.js'

// Consultation (Task 7) + publication consent-gated (Task 8, plan 2.4) —
// dual-auth (`TenantAuthGuard` : clé API OU session, jamais admin — motif
// `EreportingController`, 2.3 Task 9) sur TOUS les endpoints. Deux services
// distincts injectés (`consultation`/`publication`, noms distincts des
// méthodes du contrôleur — attention prêtée au shadowing propriété/méthode,
// cf. message de tâche) : `AnnuaireConsultationService` (lecture seule du
// miroir Flux 14) et `AnnuairePublicationService` (écriture Flux 13 côté PA,
// gate consentement D5, machine à états Task 4).
@Controller('annuaire')
export class AnnuaireController {
  constructor(
    private readonly consultation: AnnuaireConsultationService,
    private readonly publication: AnnuairePublicationService,
  ) {}

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

  // Énumération de gestion des codes-routage PUBLIÉS PAR CE TENANT (Task 3,
  // plan 3.3, D6) : `annuaire_lignes` (routageId non-null), PAS le miroir
  // de consultation lu par `lignes` ci-dessus — le vrai trou de gestion
  // HTTP comblé ici (aucun GET n'exposait `annuaire_lignes` jusqu'ici). Vue
  // de gestion HONNÊTE : TOUTES les lignes à routageId non-null, quel que
  // soit leur statut (draft/published/deposee/rejetee/masked, amendement
  // m4) — aucun filtre de statut, contrairement à `resolution` qui ne
  // considère que ce qui est effectivement adressable. Tableau VIDE si
  // aucun code (énumération, PAS 404) ; non-fuite RLS identique à
  // `lignes` (un SIREN d'un autre tenant renvoie un tableau vide, jamais
  // une fuite d'existence).
  //
  // POST create autonome REFUSÉ (D6, ratifié) : un code-routage n'est PAS
  // une entité indépendante — c'est un composant de maille
  // (SIREN_SIRET_ROUTAGE) créé via `POST /annuaire/lignes`. Un POST
  // « create code » fabriquerait une entité absente du modèle et
  // dupliquerait le cycle de vie des lignes (aucune nouvelle table —
  // contrainte du plan). Réexaminable en 3.4+ si un besoin métier autonome
  // émerge.
  @Get('codes-routage')
  @UseGuards(TenantAuthGuard)
  async codesRoutage(
    @CurrentTenant() tenantId: string,
    @Query() query: unknown,
  ) {
    const { siren } = parseQuery(codesRoutageQuerySchema, query)
    const codes = await this.publication.listRoutingCodes(tenantId, siren)
    return { codes }
  }

  // Publication d'une ligne (Task 8) : gate consentement (422 AVANT toute
  // écriture, D5) → validité/génération F13 XSD-validée → transmission via
  // le port → draft→published. Succès partiel au grain ligne (D13) : un F13
  // localement invalide (born-rejetee, T4-F1) répond quand même 201 — la
  // RESSOURCE (la ligne) a bien été créée, seul SON statut interne est
  // `rejetee` (cf. `status`/`rejectReason` du corps de réponse).
  @Post('lignes')
  @UseGuards(TenantAuthGuard)
  async publish(@CurrentTenant() tenantId: string, @Body() body: unknown) {
    const parsed = parseBody(publishLigneBodySchema, body)
    try {
      return await this.publication.publishLigne(tenantId, parsed)
    } catch (err) {
      throw this.mapPublicationError(err)
    }
  }

  // Fin d'effet (Task 8) : positionne `dateFin` sur une ligne EXISTANTE du
  // tenant. 404 anti-fuite si l'id est inconnu/hors tenant (même motif que
  // `resolution`), 422 si `dateFin` ne suit pas strictement la `dateDebut`
  // existante, 409 si la ligne est déjà dans un statut terminal
  // (rejetee/masked — `updateDateFin`, annuaire.repository.ts).
  @Put('lignes/:id')
  @UseGuards(TenantAuthGuard)
  async endEffect(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    if (!isUuid(id)) throw this.notFound()
    const existing = await this.publication.getLigne(tenantId, id)
    if (!existing) throw this.notFound()
    const parsed = parseBody(endEffectBodySchema, body)
    try {
      await this.publication.endEffect(tenantId, id, parsed.dateFin)
    } catch (err) {
      throw this.mapPublicationError(err)
    }
    return { id, dateFin: parsed.dateFin }
  }

  // Masquage (Task 8) : deposee→masked (A-DEADLOCK, immédiat-terminal, D6).
  // 404 anti-fuite si l'id est inconnu/hors tenant, 409 si la ligne n'est pas
  // dans le statut `deposee` (déjà masquée, encore draft/published, ou née
  // rejetee).
  @Delete('lignes/:id')
  @HttpCode(204)
  @UseGuards(TenantAuthGuard)
  async mask(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
  ): Promise<void> {
    if (!isUuid(id)) throw this.notFound()
    const existing = await this.publication.getLigne(tenantId, id)
    if (!existing) throw this.notFound()
    try {
      await this.publication.maskLigne(tenantId, id)
    } catch (err) {
      throw this.mapPublicationError(err)
    }
  }

  // Ne mappe QUE les erreurs qu'un endpoint HTTP de ce contrôleur peut
  // effectivement produire (`publishLigne`/`endEffect`/`maskLigne`) —
  // `MotifRequiredError` (levée uniquement par `recordAck`, SANS route HTTP
  // dans cette tâche, D7 — motif `EreportingStatusService`) n'apparaît
  // délibérément PAS ici : un branchement mort pour une erreur qu'aucun
  // appelant HTTP ne peut jamais déclencher serait un faux sentiment de
  // couverture (`recordAck` est testé directement, e2e/unitaire).
  private mapPublicationError(err: unknown): unknown {
    if (err instanceof ConsentRequiredError) {
      return new UnprocessableEntityException(
        problem(422, ProblemType.businessRule, 'Consent required', {
          detail:
            'aucun consentement actif ne couvre cette maille (§3.5.5.5, D5)',
        }),
      )
    }
    if (err instanceof InvalidLignePeriodError) {
      return new UnprocessableEntityException(
        problem(422, ProblemType.validation, 'Invalid period', {
          detail: err.message,
        }),
      )
    }
    if (
      err instanceof LigneSlotConflictError ||
      err instanceof StaleLigneTransitionError
    ) {
      return new ConflictException(
        problem(409, ProblemType.conflict, 'Conflict', {
          detail: err.message,
        }),
      )
    }
    return err
  }

  private notFound(): NotFoundException {
    return new NotFoundException(
      problem(404, ProblemType.notFound, 'Unknown ligne'),
    )
  }
}
