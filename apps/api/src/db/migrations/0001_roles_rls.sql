GRANT USAGE ON SCHEMA public TO factelec_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON tenants, api_keys, invoices, invoice_formats TO factelec_app;
--> statement-breakpoint
ALTER TABLE tenants         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants         FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE api_keys        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE api_keys        FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoices        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoices        FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_formats ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_formats FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
-- current_setting(..., true) : missing_ok → NULL si non posé → fail-closed.
-- nullif(..., '') : un GUC custom déjà touché dans la session (set_config(...,true))
-- revient à '' (pas NULL) une fois la transaction terminée — quirk documenté de
-- Postgres pour les paramètres placeholder. Sans ce nullif, ''::uuid lève une
-- exception au lieu de fermer proprement l'accès (0 ligne) hors contexte tenant.
CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invoice_formats
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_self ON tenants
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Poule/œuf : l'auth précède le contexte tenant. SECURITY DEFINER (owner, BYPASSRLS),
-- bornée à UN préfixe, ne renvoie que le nécessaire. app n'a que EXECUTE.
CREATE OR REPLACE FUNCTION authenticate_api_key(p_prefix text)
RETURNS TABLE (api_key_id uuid, tenant_id uuid, secret_hash text, revoked_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT id, tenant_id, secret_hash, revoked_at
  FROM api_keys
  WHERE prefix = p_prefix
  LIMIT 1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION authenticate_api_key(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION authenticate_api_key(text) TO factelec_app;
