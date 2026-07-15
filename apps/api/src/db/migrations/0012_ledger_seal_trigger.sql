-- Scellement à valeur probante du journal invoice_status_events (spec §4.5,
-- intégrité CGI art. 289 bis/289 E). Le hash chaîné SHA-256 par tenant est
-- calculé PAR LA BASE (non contournable par l'application, D1) : trigger
-- BEFORE INSERT SECURITY DEFINER (propriété owner, search_path épinglé) qui
-- écrase tout seq/prev_hash/hash fourni par le client. factelec_app conserve
-- SELECT+INSERT seulement (aucun UPDATE/DELETE → immuabilité, migration 0008).
-- Hypothèse : encodage base de données = UTF8 (octet_length = octets UTF-8,
-- miroir de Buffer.byteLength côté Node — cf. src/ledger/ledger-hash.ts).

-- Défense en profondeur (revue contrôleur) : search_path épinglé à
-- pg_catalog, pg_temp (PAS public) et objets du schéma applicatif
-- schéma-qualifiés (public.digest, public.ledger_field,
-- public.invoice_status_events). Le propriétaire (factelec_owner) est
-- BYPASSRLS ; laisser search_path=public exposerait ces fonctions
-- SECURITY DEFINER à un shadowing d'objet (escalade) si factelec_app
-- obtenait un jour CREATE sur public — on ne veut pas en dépendre.

-- Encodage d'un champ, longueur-préfixé (injection-proof) : NULL → '-1|',
-- sinon octet_length||'|'||valeur. IMMUTABLE (pur).
CREATE OR REPLACE FUNCTION ledger_field(v text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN v IS NULL THEN '-1|'
    ELSE octet_length(v)::text || '|' || v
  END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ledger_field(text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION seal_status_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  head_seq  bigint;
  head_hash bytea;
  ts_ms     bigint;
  canonical text;
BEGIN
  -- Sérialise les insertions du MÊME tenant (anti-fork) sans bloquer les autres.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));

  -- Horodatage tronqué ms (précision représentable par Date JS → égalité PG↔Node).
  NEW.created_at := date_trunc('milliseconds', COALESCE(NEW.created_at, now()));
  ts_ms := (extract(epoch FROM NEW.created_at) * 1000)::bigint;

  SELECT e.seq, e.hash INTO head_seq, head_hash
  FROM public.invoice_status_events e
  WHERE e.tenant_id = NEW.tenant_id
  ORDER BY e.seq DESC
  LIMIT 1;

  IF head_seq IS NULL THEN
    NEW.seq := 1;
    -- Genesis dérivé du tenant (origine liée à son identité).
    NEW.prev_hash := public.digest(
      convert_to('factelec:ledger:genesis:v1:' || NEW.tenant_id::text, 'UTF8'),
      'sha256'
    );
  ELSE
    NEW.seq := head_seq + 1;
    NEW.prev_hash := head_hash;
  END IF;

  -- Ordre FIGÉ, miroir exact de canonicalizeStatusEvent (Task 3).
  canonical :=
       public.ledger_field(NEW.tenant_id::text)
    || public.ledger_field(NEW.invoice_id::text)
    || public.ledger_field(NEW.seq::text)
    || public.ledger_field(NEW.from_status::text)
    || public.ledger_field(NEW.to_status::text)
    || public.ledger_field(NEW.actor)
    || public.ledger_field(NEW.reason)
    || public.ledger_field(ts_ms::text);

  NEW.hash := public.digest(NEW.prev_hash || convert_to(canonical, 'UTF8'), 'sha256');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION seal_status_event() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_seal_status_event
  BEFORE INSERT ON invoice_status_events
  FOR EACH ROW
  EXECUTE FUNCTION seal_status_event();
