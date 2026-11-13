-- Additive synthetic rehearsal safeguards. Included transactionally by proposed
-- 006, never appended to or substituted for registered 004/005. No mutation role
-- is granted and no approval/APPLY interface is introduced.
DO $gate$
BEGIN
  IF current_user<>'nukhabapay_migrator' OR current_database() !~ '^nukhabapay_b3b[23]_[0-9a-f]{32}$'
    OR COALESCE(host(inet_server_addr()),'') NOT IN ('127.0.0.1','::1') OR inet_server_port() IS DISTINCT FROM 5432
    OR NOT EXISTS(SELECT 1 FROM nukhabapay.schema_migrations WHERE name='004_staff_identity_foundation') THEN
    RAISE EXCEPTION 'Unapproved authority safeguard target' USING ERRCODE='42501';
  END IF;
END $gate$;
GRANT SELECT(tokens_valid_after) ON nukhabapay.staff_users TO nukhabapay_identity_reader;

CREATE FUNCTION nukhabapay.advance_staff_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF NEW.id<>OLD.id OR NEW.authz_version NOT IN (OLD.authz_version,OLD.authz_version+1)
    OR (OLD.tokens_valid_after IS NOT NULL AND (NEW.tokens_valid_after IS NULL OR NEW.tokens_valid_after<OLD.tokens_valid_after)) THEN
    RAISE EXCEPTION 'Authority versions and cutoffs are monotonic' USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.tokens_valid_after IS DISTINCT FROM OLD.tokens_valid_after
    OR NEW.authz_version<>OLD.authz_version THEN
    NEW.authz_version:=OLD.authz_version+1;
    NEW.tokens_valid_after:=greatest(OLD.tokens_valid_after,NEW.tokens_valid_after,clock_timestamp());
    NEW.updated_at:=greatest(NEW.updated_at,clock_timestamp());
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER staff_authority_version BEFORE UPDATE ON nukhabapay.staff_users
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.advance_staff_authority();

CREATE FUNCTION nukhabapay.advance_membership_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF ROW(NEW.id,NEW.staff_id,NEW.tenant_id) IS DISTINCT FROM ROW(OLD.id,OLD.staff_id,OLD.tenant_id)
    OR NEW.version NOT IN (OLD.version,OLD.version+1) THEN
    RAISE EXCEPTION 'Immutable membership binding or invalid version' USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.version<>OLD.version THEN
    NEW.version:=OLD.version+1; NEW.updated_at:=greatest(NEW.updated_at,clock_timestamp());
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER membership_authority_version BEFORE UPDATE ON nukhabapay.staff_memberships
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.advance_membership_authority();

CREATE FUNCTION nukhabapay.propagate_staff_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
DECLARE person uuid; changed integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retain canonical authority history' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' THEN
    CASE TG_TABLE_NAME
      WHEN 'staff_identities' THEN
        IF ROW(NEW.id,NEW.staff_id,NEW.issuer,NEW.subject) IS DISTINCT FROM ROW(OLD.id,OLD.staff_id,OLD.issuer,OLD.subject) THEN
          RAISE EXCEPTION 'Immutable identity binding' USING ERRCODE='23514'; END IF;
      WHEN 'platform_role_grants' THEN
        IF ROW(NEW.id,NEW.staff_id,NEW.role_code,NEW.scope) IS DISTINCT FROM ROW(OLD.id,OLD.staff_id,OLD.role_code,OLD.scope) THEN
          RAISE EXCEPTION 'Immutable platform grant binding' USING ERRCODE='23514'; END IF;
      WHEN 'tenant_role_grants' THEN
        IF ROW(NEW.id,NEW.membership_id,NEW.tenant_id,NEW.role_code,NEW.scope) IS DISTINCT FROM ROW(OLD.id,OLD.membership_id,OLD.tenant_id,OLD.role_code,OLD.scope) THEN
          RAISE EXCEPTION 'Immutable tenant grant binding' USING ERRCODE='23514'; END IF;
      ELSE NULL;
    END CASE;
    IF TG_TABLE_NAME IN ('platform_role_grants','tenant_role_grants') THEN
      IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NULL OR NEW.revoked_at<OLD.revoked_at) THEN
        RAISE EXCEPTION 'Revocation cannot be undone' USING ERRCODE='23514'; END IF;
    END IF;
    IF (to_jsonb(NEW)-'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='tenant_role_grants' THEN
    UPDATE nukhabapay.staff_memberships SET version=version+1 WHERE id=NEW.membership_id AND tenant_id=NEW.tenant_id;
  ELSE
    person:=NEW.staff_id;
    UPDATE nukhabapay.staff_users SET authz_version=authz_version+1 WHERE id=person;
  END IF;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'Authority propagation denied' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER identity_authority_changed BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.staff_identities
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.propagate_staff_authority();
CREATE TRIGGER membership_authority_changed BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.staff_memberships
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.propagate_staff_authority();
CREATE TRIGGER platform_grant_authority_changed BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.platform_role_grants
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.propagate_staff_authority();
CREATE TRIGGER tenant_grant_authority_changed BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.tenant_role_grants
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.propagate_staff_authority();
-- Catalog changes need an explicit future migration, not a runtime permission edit.
CREATE TRIGGER fixed_iam_roles BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.iam_roles
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation();
CREATE TRIGGER fixed_iam_permissions BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.iam_permissions
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation();
CREATE TRIGGER fixed_iam_role_permissions BEFORE INSERT OR UPDATE OR DELETE ON nukhabapay.iam_role_permissions
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation();
REVOKE ALL ON FUNCTION nukhabapay.advance_staff_authority(),nukhabapay.advance_membership_authority(),nukhabapay.propagate_staff_authority()
  FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;
