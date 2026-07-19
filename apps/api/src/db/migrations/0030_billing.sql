CREATE TYPE "public"."billing_status" AS ENUM ('none', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete');
--> statement-breakpoint
CREATE TABLE "tenant_billing" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"status" "billing_status" DEFAULT 'none' NOT NULL,
	"current_period_end" timestamp with time zone,
	"last_event_created" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_usage_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"day" text NOT NULL,
	"count" integer NOT NULL,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD CONSTRAINT "tenant_billing_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_usage_reports" ADD CONSTRAINT "billing_usage_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_customer_unique" ON "tenant_billing" USING btree ("stripe_customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_usage_reports_tenant_day_unique" ON "billing_usage_reports" USING btree ("tenant_id","day");
--> statement-breakpoint
-- RLS FORCE + moindre privilège (gabarit tenant_isolation, cf. 0025). Le
-- miroir billing est mutable (UPDATE) contrairement aux captures payments :
-- il suit l'état Stripe. Pas de DELETE (historique comptable, spec §3).
ALTER TABLE tenant_billing ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant_billing FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_billing
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON tenant_billing TO factelec_app;
--> statement-breakpoint
GRANT SELECT ON tenant_billing TO factelec_worker;
--> statement-breakpoint
ALTER TABLE billing_usage_reports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE billing_usage_reports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON billing_usage_reports
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT ON billing_usage_reports TO factelec_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON billing_usage_reports TO factelec_worker;
--> statement-breakpoint
-- SD 1 : résolution du tenant d'un webhook par customer Stripe — le webhook
-- arrive SANS contexte tenant (RLS bloquerait). STRUCTURELLEMENT read-only
-- (LANGUAGE sql, un seul SELECT), projette une seule colonne — même posture
-- que find_stuck_generation_invoices (2.1).
CREATE FUNCTION find_billing_tenant_by_customer(p_customer text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM tenant_billing WHERE stripe_customer_id = p_customer;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_billing_tenant_by_customer(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_billing_tenant_by_customer(text) TO factelec_app;
--> statement-breakpoint
-- SD 2 : énumération des tenants abonnés pour le sweep d'usage (worker,
-- cross-tenant par nature). Read-only, colonnes projetées seulement.
CREATE FUNCTION find_billing_subscribed_tenants()
RETURNS TABLE(tenant_id uuid, stripe_customer_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id, stripe_customer_id
  FROM tenant_billing
  WHERE status IN ('trialing', 'active', 'past_due')
    AND stripe_customer_id IS NOT NULL;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_billing_subscribed_tenants() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_billing_subscribed_tenants() TO factelec_worker;
