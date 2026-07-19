-- Phase 5 it.2, Task 2 (spec §2) : suspension tenants, MFA TOTP admin,
-- journal d'audit admin_actions, 2 fonctions SD de supervision cross-tenant.

-- ── Suspension opérateur (spec §2/§4) ──────────────────────────────────────
-- NULL = actif. Suspendu ⇔ suspended_at IS NOT NULL — seul discriminant lu
-- par SuspensionGuard (Task 3).
ALTER TABLE "tenants" ADD COLUMN "suspended_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "suspended_reason" text;
--> statement-breakpoint

-- ── MFA TOTP admin (spec §5) ────────────────────────────────────────────────
-- totp_secret : base32, posé PENDING à l'enrôlement (POST /admin/login).
-- totp_enabled_at NULL = enrôlement PENDING (pas encore confirmé par
-- POST /admin/totp/confirm). recovery_codes : hashs argon2id, un par code,
-- retiré du tableau à l'usage.
ALTER TABLE "platform_admins" ADD COLUMN "totp_secret" text;
--> statement-breakpoint
ALTER TABLE "platform_admins" ADD COLUMN "totp_enabled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform_admins" ADD COLUMN "recovery_codes" jsonb;
--> statement-breakpoint

-- ── Journal d'audit admin_actions (spec §2/§3) ─────────────────────────────
CREATE TABLE "admin_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"action" text NOT NULL,
	"tenant_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_admin_id_platform_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."platform_admins"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Tri des lectures (dashboard admin, plus récent d'abord) — pas d'index
-- tenant_id : la lecture est cross-tenant par nature (jamais un WHERE
-- tenant_id = ? isolé côté admin), contrairement aux journaux tenant-scopés
-- (cdv_transmission_events, ereporting_status_events).
CREATE INDEX "admin_actions_created_at_idx" ON "admin_actions" USING btree ("created_at" DESC);
--> statement-breakpoint
-- admin_actions est une table PLATEFORME (comme platform_admins), PAS
-- tenant-scopée malgré la colonne tenant_id (nullable, simple référence à
-- l'objet de l'action — jamais un WHERE tenant_id = current_setting(...)).
-- PAS de RLS/policy tenant_isolation ici, à la différence de payments/
-- tenant_billing/cdv_transmissions etc. : contrairement à platform_admins/
-- sessions (FORCE RLS SANS policy → deny-all, accès uniquement via
-- fonctions SECURITY DEFINER), admin_actions est lue/écrite DIRECTEMENT par
-- l'API admin via factelec_app — activer FORCE RLS sans policy aurait
-- neutralisé les GRANTs ci-dessous (deny-all pour un rôle NOBYPASSRLS),
-- et une policy tenant_isolation n'a pas de sens pour un journal cross-
-- tenant. L'isolation est donc portée par les GRANTs seuls : APPEND-ONLY
-- (SELECT, INSERT — jamais UPDATE/DELETE, à personne), motif payments 0025
-- (un fait journalisé n'est jamais corrigé en place).
GRANT SELECT, INSERT ON admin_actions TO factelec_app;
--> statement-breakpoint

-- ── SD 1 : find_admin_tenant_stats — liste tenants enrichie (spec §3, ─────
-- GET /admin/tenants). Cross-tenant par nature (dashboard admin), STRUCTU-
-- RELLEMENT read-only (LANGUAGE sql, UN SEUL SELECT), colonnes projetées
-- bornées (aucun contenu de facture) — même posture que find_billing_*
-- (migration 0030).
CREATE FUNCTION find_admin_tenant_stats()
RETURNS TABLE(
  tenant_id uuid,
  name text,
  siren text,
  created_at timestamptz,
  suspended_at timestamptz,
  billing_status text,
  invoices_30d bigint,
  ereporting_30d bigint,
  dead_letters bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    t.id,
    t.name,
    t.siren,
    t.created_at,
    t.suspended_at,
    coalesce(tb.status::text, 'none'),
    (SELECT count(*) FROM invoices i
       WHERE i.tenant_id = t.id AND i.created_at >= now() - interval '30 days'),
    (SELECT count(*) FROM ereporting_transmissions e
       WHERE e.tenant_id = t.id AND e.created_at >= now() - interval '30 days'),
    (SELECT count(*) FROM invoice_dead_letters d WHERE d.tenant_id = t.id)
  FROM tenants t
  LEFT JOIN tenant_billing tb ON tb.tenant_id = t.id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_admin_tenant_stats() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_admin_tenant_stats() TO factelec_app;
--> statement-breakpoint

-- ── SD 2 : find_admin_anomalies — vue anomalies lecture seule (spec §3, ───
-- GET /admin/anomalies). UN SEUL SELECT englobant un sous-SELECT UNION ALL
-- de 3 branches (chacune bornée LIMIT p_limit pour éviter un balayage
-- complet d'une table volumineuse avant le tri global), puis tri
-- created_at DESC + LIMIT p_limit global. JAMAIS de colonne de contenu de
-- facture (pas de payload/xml/montant) — ref_id renvoie l'id de la ligne
-- source (dead letter / transmission), pas l'id de la facture elle-même,
-- pour laisser le détail tenant (Task 3+) résoudre la facture sous RLS.
--
-- Branche ereporting_failed : l'énum ereporting_status (migration 0016) est
-- 'prepared'|'transmitted'|'deposee'|'rejetee' — AUCUNE valeur 'failed'.
-- 'rejetee' est l'état TERMINAL d'échec (rejet PPF, cf. commentaire enum
-- schema.ts "300/301 Tableaux 5/6 DGFiP = deposee/rejetee") : c'est la
-- valeur la plus proche d'un échec et celle utilisée ici, à la place de
-- 'failed' qui n'existe pas dans ce domaine.
CREATE FUNCTION find_admin_anomalies(p_limit integer)
RETURNS TABLE(
  kind text,
  tenant_id uuid,
  ref_id uuid,
  detail text,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT kind, tenant_id, ref_id, detail, created_at
  FROM (
    (SELECT 'dead_letter' AS kind, tenant_id, id AS ref_id, reason AS detail, created_at
       FROM invoice_dead_letters
       ORDER BY created_at DESC
       LIMIT p_limit)
    UNION ALL
    (SELECT 'cdv_parked' AS kind, tenant_id, id AS ref_id,
            coalesce(reject_reason, status::text) AS detail, created_at
       FROM cdv_transmissions
       WHERE status IN ('parked', 'rejected')
       ORDER BY created_at DESC
       LIMIT p_limit)
    UNION ALL
    (SELECT 'ereporting_failed' AS kind, tenant_id, id AS ref_id, status::text AS detail, created_at
       FROM ereporting_transmissions
       WHERE status = 'rejetee'
       ORDER BY created_at DESC
       LIMIT p_limit)
  ) anomalies
  ORDER BY created_at DESC
  LIMIT p_limit;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_admin_anomalies(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_admin_anomalies(integer) TO factelec_app;
