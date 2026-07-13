-- Plan d'authentification humaine : RLS + fonctions SECURITY DEFINER.
-- users : tenant-scopé (gabarit tenant_isolation de 0001).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- sessions & platform_admins : FORCE sans policy → deny-all pour factelec_app
-- (accès uniquement via les fonctions SECURITY DEFINER ci-dessous).
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Moindre privilège : SELECT users (GET /auth/me) ; INSERT users via signup_tenant.
GRANT SELECT ON users TO factelec_app;
--> statement-breakpoint
-- sessions & platform_admins : aucun GRANT direct.

-- ── Fonctions SECURITY DEFINER ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION authenticate_user(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, role user_role, password_hash text, email_verified boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT id, tenant_id, role, password_hash, email_verified
  FROM users WHERE lower(email) = lower(p_email) LIMIT 1;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION authenticate_platform_admin(p_email text)
RETURNS TABLE (admin_id uuid, password_hash text)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT id, password_hash FROM platform_admins WHERE lower(email) = lower(p_email) LIMIT 1;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION signup_tenant(p_email text, p_password_hash text, p_tenant_name text, p_siren text)
RETURNS TABLE (user_id uuid, tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tenant uuid; v_user uuid;
BEGIN
  INSERT INTO tenants (name, siren) VALUES (p_tenant_name, p_siren) RETURNING id INTO v_tenant;
  INSERT INTO users (tenant_id, email, password_hash, role)
    VALUES (v_tenant, p_email, p_password_hash, 'owner') RETURNING id INTO v_user;
  RETURN QUERY SELECT v_user, v_tenant;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION create_session(
  p_user_id uuid, p_admin_id uuid, p_tenant_id uuid,
  p_token_hash text, p_csrf_hash text, p_expires_at timestamptz)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  INSERT INTO sessions (user_id, admin_id, tenant_id, token_hash, csrf_hash, expires_at)
  VALUES (p_user_id, p_admin_id, p_tenant_id, p_token_hash, p_csrf_hash, p_expires_at)
  RETURNING id;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION find_session(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, admin_id uuid, tenant_id uuid, role user_role, csrf_hash text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT s.id, s.user_id, s.admin_id, s.tenant_id, u.role, s.csrf_hash, s.expires_at
  FROM sessions s LEFT JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash LIMIT 1;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION revoke_session(p_token_hash text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  DELETE FROM sessions WHERE token_hash = p_token_hash;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION list_tenants_for_admin()
RETURNS TABLE (id uuid, name text, siren text, created_at timestamptz, user_count bigint, invoice_count bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT t.id, t.name, t.siren, t.created_at,
         (SELECT count(*) FROM users u WHERE u.tenant_id = t.id),
         (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id)
  FROM tenants t ORDER BY t.created_at DESC;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION authenticate_user(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION authenticate_user(text) TO factelec_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION authenticate_platform_admin(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION authenticate_platform_admin(text) TO factelec_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION signup_tenant(text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION signup_tenant(text, text, text, text) TO factelec_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION create_session(uuid, uuid, uuid, text, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION create_session(uuid, uuid, uuid, text, text, timestamptz) TO factelec_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_session(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_session(text) TO factelec_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION revoke_session(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION revoke_session(text) TO factelec_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_tenants_for_admin() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION list_tenants_for_admin() TO factelec_app;
