CREATE TYPE "public"."annuaire_ligne_status" AS ENUM('draft', 'published', 'deposee', 'rejetee', 'masked');--> statement-breakpoint
CREATE TYPE "public"."annuaire_nature" AS ENUM('D', 'M');--> statement-breakpoint
CREATE TABLE "annuaire_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"siren" text NOT NULL,
	"siret" text,
	"routage_id" text,
	"suffixe" text,
	"consent_type" text NOT NULL,
	"signer_identity" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"obtained_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "annuaire_directory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"id_instance" bigint,
	"siren" text NOT NULL,
	"siret" text,
	"routage_id" text,
	"suffixe" text,
	"nature" "annuaire_nature" NOT NULL,
	"date_debut" text NOT NULL,
	"date_fin" text,
	"plateforme" text NOT NULL,
	"source_horodate" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "annuaire_ligne_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ligne_id" uuid NOT NULL,
	"from_status" "annuaire_ligne_status",
	"to_status" "annuaire_ligne_status" NOT NULL,
	"motif" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "annuaire_lignes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"siren" text NOT NULL,
	"siret" text,
	"routage_id" text,
	"suffixe" text,
	"nature" "annuaire_nature" NOT NULL,
	"date_debut" text NOT NULL,
	"date_fin" text,
	"plateforme" text NOT NULL,
	"status" "annuaire_ligne_status" DEFAULT 'draft' NOT NULL,
	"consent_id" uuid NOT NULL,
	"tracking_ref" text,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "annuaire_consents" ADD CONSTRAINT "annuaire_consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annuaire_directory_entries" ADD CONSTRAINT "annuaire_directory_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annuaire_ligne_events" ADD CONSTRAINT "annuaire_ligne_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annuaire_ligne_events" ADD CONSTRAINT "annuaire_ligne_events_ligne_id_annuaire_lignes_id_fk" FOREIGN KEY ("ligne_id") REFERENCES "public"."annuaire_lignes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annuaire_lignes" ADD CONSTRAINT "annuaire_lignes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annuaire_lignes" ADD CONSTRAINT "annuaire_lignes_consent_id_annuaire_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."annuaire_consents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "annuaire_consents_tenant_siren_idx" ON "annuaire_consents" USING btree ("tenant_id","siren");--> statement-breakpoint
CREATE INDEX "annuaire_directory_entries_tenant_siren_idx" ON "annuaire_directory_entries" USING btree ("tenant_id","siren");--> statement-breakpoint
CREATE UNIQUE INDEX "annuaire_directory_entries_maille_date_nature_unique" ON "annuaire_directory_entries" USING btree ("tenant_id","siren",coalesce("siret", ''),coalesce("routage_id", ''),coalesce("suffixe", ''),"date_debut","nature");--> statement-breakpoint
CREATE INDEX "annuaire_ligne_events_ligne_idx" ON "annuaire_ligne_events" USING btree ("ligne_id","created_at");--> statement-breakpoint
CREATE INDEX "annuaire_lignes_tenant_siren_idx" ON "annuaire_lignes" USING btree ("tenant_id","siren");--> statement-breakpoint
CREATE UNIQUE INDEX "annuaire_lignes_maille_date_definition_unique" ON "annuaire_lignes" USING btree ("tenant_id","siren",coalesce("siret", ''),coalesce("routage_id", ''),coalesce("suffixe", ''),"date_debut") WHERE "annuaire_lignes"."nature" = 'D' AND "annuaire_lignes"."status" NOT IN ('rejetee', 'masked');