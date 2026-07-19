-- Phase 5 it.2, Task 7 (spec §5) : fonctions SECURITY DEFINER pour le flux
-- MFA TOTP admin. `platform_admins` reste FORCE RLS SANS policy (deny-all
-- pour factelec_app, posé migration 0003) — AUCUN accès direct possible aux
-- 3 nouvelles colonnes (totp_secret/totp_enabled_at/recovery_codes, 0031),
-- donc chaque lecture/écriture passe par une fonction dédiée ci-dessous,
-- même discipline que authenticate_platform_admin/create_session/
-- find_session/revoke_session (0003).

-- ── authenticate_platform_admin : élargie (0003 → 5 colonnes) ─────────────
-- Changement de type de retour : CREATE OR REPLACE l'interdit (Postgres
-- refuse un changement de signature de retour), DROP + CREATE requis. Seul
-- appelant : AdminService.login/confirmTotp (grep vérifié) — aucune autre
-- fonction SD n'en dépend.
DROP FUNCTION IF EXISTS authenticate_platform_admin(text);
--> statement-breakpoint
CREATE FUNCTION authenticate_platform_admin(p_email text)
RETURNS TABLE (
  admin_id uuid,
  password_hash text,
  totp_secret text,
  totp_enabled_at timestamptz,
  recovery_codes jsonb
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT id, password_hash, totp_secret, totp_enabled_at, recovery_codes
  FROM platform_admins WHERE lower(email) = lower(p_email) LIMIT 1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION authenticate_platform_admin(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION authenticate_platform_admin(text) TO factelec_app;
--> statement-breakpoint

-- ── set_admin_totp_secret_pending : pose le secret PENDING (spec §5, ─────
-- POST /admin/login quand password OK + non enrôlé) — UN SEUL UPDATE,
-- `coalesce(totp_secret, p_secret)` : si un secret PENDING existe déjà
-- (généré par une tentative de login précédente, jamais confirmée), il est
-- CONSERVÉ (jamais régénéré — le QR déjà affiché à l'admin resterait sinon
-- valide pour un secret différent de celui en base). RETURNING renvoie la
-- valeur DÉFINITIVE post-écriture (celle qui a gagné en cas de course entre
-- deux requêtes concurrentes, verrouillage ligne standard Postgres) — c'est
-- TOUJOURS elle qu'AdminService doit utiliser pour otpauthUrl, jamais le
-- secret généré localement en Node si un autre a déjà gagné la course.
CREATE FUNCTION set_admin_totp_secret_pending(p_admin_id uuid, p_secret text)
RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE platform_admins
  SET totp_secret = coalesce(totp_secret, p_secret)
  WHERE id = p_admin_id
  RETURNING totp_secret;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION set_admin_totp_secret_pending(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION set_admin_totp_secret_pending(uuid, text) TO factelec_app;
--> statement-breakpoint

-- ── confirm_admin_totp : POST /admin/totp/confirm (spec §5) ──────────────
-- Pose totp_enabled_at + les 10 recovery codes hashés EN UNE FOIS, protégé
-- par `WHERE totp_enabled_at IS NULL` (idempotence : un admin déjà enrôlé ne
-- peut pas re-confirmer et écraser ses recovery codes existants — 0 ligne
-- affectée, RETURNING ne renvoie rien, `boolean` NULL côté appelant → 401
-- générique posé par AdminService, motif anti-oracle spec §5).
CREATE FUNCTION confirm_admin_totp(p_admin_id uuid, p_recovery_codes jsonb)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE platform_admins
  SET totp_enabled_at = now(), recovery_codes = p_recovery_codes
  WHERE id = p_admin_id AND totp_enabled_at IS NULL
  RETURNING true;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION confirm_admin_totp(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION confirm_admin_totp(uuid, jsonb) TO factelec_app;
--> statement-breakpoint

-- ── set_admin_recovery_codes : retire un code consommé (spec §5, POST ────
-- /admin/login via recoveryCode) — écrit le tableau `remaining` calculé par
-- TotpService.consumeRecoveryCode (le code employé déjà retiré côté Node).
--
-- CAS (compare-and-swap) sur `p_prior` (revue sécurité Task 7, Issue 1) :
-- SANS `AND recovery_codes = p_prior`, deux logins CONCURRENTS avec le MÊME
-- recovery code lisent tous deux la même ligne AVANT que l'un des deux
-- n'écrive (lecture faite par AdminService.login via authenticate_platform_
-- admin, dans une requête SQL SÉPARÉE de celle-ci) — chacun calcule
-- indépendamment `remaining` (le même tableau) et l'écrit sans condition :
-- les DEUX logins réussissent (double-spend d'un code à usage unique). La
-- clause `WHERE recovery_codes = p_prior` (jsonb, égalité structurelle —
-- comparaison profonde, PAS une comparaison de texte) transforme l'UPDATE
-- en CAS : le verrouillage ligne standard de Postgres sérialise les deux
-- UPDATE concurrents (le second bloque jusqu'au COMMIT du premier), puis le
-- second réévalue le WHERE contre l'état POST-COMMIT du premier — qui a déjà
-- changé `recovery_codes`, donc `= p_prior` échoue, 0 ligne affectée,
-- RETURNING ne renvoie rien → AdminService traite ça comme un code déjà
-- consommé (même 401 générique, motif confirm_admin_totp ci-dessus).
CREATE FUNCTION set_admin_recovery_codes(
  p_admin_id uuid, p_recovery_codes jsonb, p_prior jsonb
)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE platform_admins
  SET recovery_codes = p_recovery_codes
  WHERE id = p_admin_id AND recovery_codes = p_prior
  RETURNING true;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION set_admin_recovery_codes(uuid, jsonb, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION set_admin_recovery_codes(uuid, jsonb, jsonb) TO factelec_app;
