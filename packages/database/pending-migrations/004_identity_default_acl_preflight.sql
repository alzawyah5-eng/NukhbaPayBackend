-- Reviewed deployment prerequisite, not a replacement for frozen migration 004.
-- Run as the verified migration owner before the sequence, under the deployment
-- advisory lock. No grants/defaults/history are changed by this preflight.
DO $preflight$
DECLARE owner_id oid := (SELECT oid FROM pg_roles WHERE rolname=current_user);
BEGIN
  IF current_user<>'nukhabapay_migrator'
    OR current_database() !~ '^nukhabapay_(db|i|cli|r|iam|b3b[23])_[0-9a-f]{32}$'
    OR COALESCE(host(inet_server_addr()),'') NOT IN ('127.0.0.1','::1')
    OR inet_server_port() IS DISTINCT FROM 5432
    OR NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=owner_id) THEN
    RAISE EXCEPTION 'Unapproved identity preflight target' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclrole=owner_id AND d.defaclobjtype IN ('r','f','n','S') AND a.grantee<>owner_id
      AND NOT(d.defaclobjtype='r' AND d.defaclnamespace='nukhabapay'::regnamespace
        AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('nukhabapay_runtime','nukhabapay_importer'))
        AND a.privilege_type='SELECT' AND NOT a.is_grantable)
      AND NOT(d.defaclobjtype='f' AND d.defaclnamespace=0 AND a.grantee=0 AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)) THEN
    RAISE EXCEPTION 'Unreviewed identity default privileges' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
    WHERE n.nspname='nukhabapay' AND (n.nspowner<>owner_id OR (a.grantee<>owner_id AND NOT(
      a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('nukhabapay_runtime','nukhabapay_importer','nukhabapay_identity_reader','nukhabapay_identity_writer'))
      AND a.privilege_type='USAGE' AND NOT a.is_grantable)))) THEN
    RAISE EXCEPTION 'Unreviewed identity schema privileges' USING ERRCODE='42501';
  END IF;
END $preflight$;
