-- psql variables: layer1_role (pre-existing restricted login), tenant_id, provider_account_id.
-- Run as catalogue schema owner. CONNECT on the designated catalogue database is provisioned separately.
BEGIN;
GRANT USAGE ON SCHEMA nukhabapay TO :"layer1_role";
GRANT SELECT ON nukhabapay.layer1_active_accounts,nukhabapay.layer1_source_offers TO :"layer1_role";
GRANT SELECT ON nukhabapay.layer1_account_grants TO :"layer1_role";
GRANT SELECT,INSERT ON nukhabapay.layer1_cost_snapshots,nukhabapay.layer1_fx_snapshots,
  nukhabapay.layer1_policies,nukhabapay.layer1_results,nukhabapay.layer1_outbox,nukhabapay.layer1_inbox TO :"layer1_role";
GRANT UPDATE (lease,lease_until,attempt,next_attempt_at,delivered_at) ON nukhabapay.layer1_outbox TO :"layer1_role";
INSERT INTO nukhabapay.layer1_account_grants (login_role,tenant_id,provider_account_id)
VALUES (:'layer1_role',:'tenant_id',:'provider_account_id') ON CONFLICT DO NOTHING;
COMMIT;
