-- Dette 1.3 : écrire last_used_at à l'authentification par clé API. La fonction
-- authenticate_api_key (0001) est la SEULE exécutée avant le contexte tenant
-- (poule/œuf), donc le seul endroit où poser last_used_at sans casser la RLS.
-- Elle devient plpgsql VOLATILE avec UPDATE ... RETURNING (SECURITY DEFINER
-- owner → bypass RLS ; SIGNATURE INCHANGÉE : impératif pour CREATE OR REPLACE,
-- les GRANTs de 0001 restent donc valides sans nouveau REVOKE/GRANT).
-- ⚠ last_used_at est posé sur simple correspondance de PRÉFIXE (avant la
-- vérification du secret, impossible ici) ; le préfixe faisant 96 bits (12 o),
-- une correspondance ≈ usage de la vraie clé — sémantique « dernière
-- présentation de la clé » assumée et documentée.
-- Déviation volontaire par rapport au brief initial : `AND revoked_at IS
-- NULL` ajouté au WHERE. Une clé révoquée reste rejetée (401, timing-safe,
-- inchangé — cf. ApiKeyService.authenticate, ligne `!row || row.revoked_at`
-- devenant simplement `!row`) mais ne doit PAS voir son `last_used_at`
-- avancer : ce n'est pas un « usage » légitime, et faire autrement aurait
-- rendu observable, via `last_used_at`, qu'un attaquant présente une clé
-- révoquée en boucle. La colonne `revoked_at` du résultat reste dans la
-- signature (toujours NULL désormais, la ligne n'étant renvoyée QUE si non
-- révoquée) : conservée uniquement pour ne pas changer la signature.
-- Alias `ak` sur la table cible de l'UPDATE : les paramètres OUT de
-- RETURNS TABLE (tenant_id, revoked_at) deviennent des variables plpgsql
-- visibles dans TOUT le corps de la fonction — sans alias, `WHERE
-- tenant_id = ...` / `RETURNING tenant_id, revoked_at` sont AMBIGUS entre
-- la variable et la colonne de même nom (« column reference "revoked_at"
-- is ambiguous », vérifié empiriquement contre Postgres réel via
-- Testcontainers, RED de l'e2e avant ce correctif).
CREATE OR REPLACE FUNCTION authenticate_api_key(p_prefix text)
RETURNS TABLE (api_key_id uuid, tenant_id uuid, secret_hash text, revoked_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $$
BEGIN
  RETURN QUERY
  UPDATE api_keys ak
     SET last_used_at = now()
   WHERE ak.prefix = p_prefix
     AND ak.revoked_at IS NULL
  RETURNING ak.id, ak.tenant_id, ak.secret_hash, ak.revoked_at;
END;
$$;
--> statement-breakpoint
-- Dette 1.4 : purge des sessions expirées (job répétable, Task 7). sessions est
-- deny-all pour factelec_app → SECURITY DEFINER. Retourne le nombre de lignes
-- supprimées (observabilité, cf. MaintenanceProcessor).
CREATE OR REPLACE FUNCTION purge_expired_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE deleted integer;
BEGIN
  DELETE FROM sessions WHERE expires_at < now();
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_expired_sessions() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_expired_sessions() TO factelec_app;
