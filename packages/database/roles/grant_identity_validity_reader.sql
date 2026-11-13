-- Additive validity projection; frozen 004 is not rewritten. Owner-operated,
-- disposable-only. Operational use requires the separate activation safeguards.
DO $validity$
BEGIN
  IF current_database() !~ '^nukhabapay_(db|i|cli|r|iam|b3b[23])_[0-9a-f]{32}$'
    OR COALESCE(host(inet_server_addr()),'') NOT IN ('127.0.0.1','::1')
    OR inet_server_port() IS DISTINCT FROM 5432 OR current_user<>'nukhabapay_migrator'
    OR NOT EXISTS(SELECT 1 FROM nukhabapay.schema_migrations WHERE name='004_staff_identity_foundation') THEN
    RAISE EXCEPTION 'Unapproved identity validity target' USING ERRCODE='42501';
  END IF;
  GRANT SELECT(tokens_valid_after) ON nukhabapay.staff_users TO nukhabapay_identity_reader;
END $validity$;
