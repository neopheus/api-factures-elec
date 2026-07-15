CREATE TYPE "public"."ereporting_flux_kind" AS ENUM('transactions', 'payments');--> statement-breakpoint
CREATE TYPE "public"."ereporting_issuer_role" AS ENUM('BY', 'SE');--> statement-breakpoint
CREATE TYPE "public"."ereporting_reject_motif" AS ENUM('REJ_SEMAN', 'REJ_UNI', 'REJ_COH', 'REJ_PER');--> statement-breakpoint
CREATE TYPE "public"."ereporting_status" AS ENUM('prepared', 'transmitted', 'deposee', 'rejetee');--> statement-breakpoint
CREATE TYPE "public"."ereporting_transmission_type" AS ENUM('IN', 'RE');--> statement-breakpoint
CREATE TYPE "public"."ereporting_vat_regime" AS ENUM('reel_normal_mensuel', 'reel_normal_trimestriel', 'simplifie', 'franchise');--> statement-breakpoint
CREATE TABLE "ereporting_declarants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"siren" text NOT NULL,
	"name" text NOT NULL,
	"role" "ereporting_issuer_role" NOT NULL,
	"vat_regime" "ereporting_vat_regime" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ereporting_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transmission_id" uuid NOT NULL,
	"from_status" "ereporting_status",
	"to_status" "ereporting_status" NOT NULL,
	"motif" "ereporting_reject_motif",
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ereporting_transmissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"declarant_id" uuid NOT NULL,
	"transmission_ref" text NOT NULL,
	"type" "ereporting_transmission_type" NOT NULL,
	"flux_kind" "ereporting_flux_kind" NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"status" "ereporting_status" DEFAULT 'prepared' NOT NULL,
	"invoice_count" integer DEFAULT 0 NOT NULL,
	"tracking_id" text,
	"xml" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ereporting_declarants" ADD CONSTRAINT "ereporting_declarants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ereporting_status_events" ADD CONSTRAINT "ereporting_status_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ereporting_status_events" ADD CONSTRAINT "ereporting_status_events_transmission_id_ereporting_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."ereporting_transmissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ereporting_transmissions" ADD CONSTRAINT "ereporting_transmissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ereporting_transmissions" ADD CONSTRAINT "ereporting_transmissions_declarant_id_ereporting_declarants_id_fk" FOREIGN KEY ("declarant_id") REFERENCES "public"."ereporting_declarants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ereporting_declarants_tenant_siren_role_unique" ON "ereporting_declarants" USING btree ("tenant_id","siren","role");--> statement-breakpoint
CREATE INDEX "ereporting_declarants_tenant_idx" ON "ereporting_declarants" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ereporting_status_events_transmission_idx" ON "ereporting_status_events" USING btree ("transmission_id","created_at");--> statement-breakpoint
CREATE INDEX "ereporting_transmissions_tenant_idx" ON "ereporting_transmissions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ereporting_transmissions_declarant_period_idx" ON "ereporting_transmissions" USING btree ("declarant_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "ereporting_transmissions_declarant_flux_period_in_unique" ON "ereporting_transmissions" USING btree ("declarant_id","flux_kind","period_start") WHERE "ereporting_transmissions"."type" = 'IN';