\getenv migration_password NUKHABAPAY_DB_MIGRATION_PASSWORD
\getenv runtime_password NUKHABAPAY_DB_RUNTIME_PASSWORD
\getenv importer_password NUKHABAPAY_DB_IMPORTER_PASSWORD

CREATE ROLE nukhabapay_migrator
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  PASSWORD :'migration_password';
CREATE ROLE nukhabapay_runtime
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  PASSWORD :'runtime_password';
CREATE ROLE nukhabapay_importer
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  PASSWORD :'importer_password';

REVOKE ALL ON DATABASE nukhabapay_dev FROM PUBLIC;
GRANT CONNECT ON DATABASE nukhabapay_dev TO nukhabapay_migrator, nukhabapay_runtime, nukhabapay_importer;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA nukhabapay AUTHORIZATION nukhabapay_migrator;
GRANT USAGE ON SCHEMA nukhabapay TO nukhabapay_runtime, nukhabapay_importer;
GRANT SELECT ON ALL TABLES IN SCHEMA nukhabapay TO nukhabapay_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA nukhabapay TO nukhabapay_importer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA nukhabapay TO nukhabapay_importer;
ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay GRANT SELECT ON TABLES TO nukhabapay_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nukhabapay_importer;
ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay GRANT USAGE, SELECT ON SEQUENCES TO nukhabapay_importer;

ALTER ROLE nukhabapay_migrator SET statement_timeout = '30000';
ALTER ROLE nukhabapay_migrator SET idle_in_transaction_session_timeout = '30000';
ALTER ROLE nukhabapay_runtime SET default_transaction_read_only = on;
ALTER ROLE nukhabapay_runtime SET statement_timeout = '5000';
ALTER ROLE nukhabapay_runtime SET idle_in_transaction_session_timeout = '15000';
ALTER ROLE nukhabapay_importer SET default_transaction_read_only = off;
ALTER ROLE nukhabapay_importer SET statement_timeout = '30000';
ALTER ROLE nukhabapay_importer SET idle_in_transaction_session_timeout = '30000';
