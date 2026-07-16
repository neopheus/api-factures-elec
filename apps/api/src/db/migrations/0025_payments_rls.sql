-- RLS FORCE + moindre privilège sur les 2 tables d'encaissement (D5, gabarit
-- tenant_isolation cf. 0008/0015/0017/0019/0022). Immutabilité par grants
-- (D5/step1) : payments ET payment_subtotals ne portent QUE SELECT, INSERT —
-- pas d'UPDATE/DELETE, contrairement à cdv_transmissions (0022) qui suit un
-- cycle de vie mutable. Une capture d'encaissement est un fait constaté,
-- jamais corrigé en place.
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON payments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON payments TO factelec_app;
--> statement-breakpoint
ALTER TABLE payment_subtotals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payment_subtotals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON payment_subtotals
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON payment_subtotals TO factelec_app;
