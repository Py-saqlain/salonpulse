-- Run only as the Neon project administrator on a NEW dedicated database.
-- No passwords in this file. Set them afterward using psql's \password prompt.
BEGIN;
DO $$
BEGIN
    IF current_database() <> 'salonpulse_prod' THEN
        RAISE EXCEPTION 'Wrong deployment database';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public') THEN
        RAISE EXCEPTION 'Expected a new empty deployment schema; review manually';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salonpulse_migrator') THEN
        CREATE ROLE salonpulse_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salonpulse_runtime') THEN
        CREATE ROLE salonpulse_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('salonpulse_runtime','salonpulse_migrator')
        AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit OR NOT rolcanlogin))
        OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member IN
            (SELECT oid FROM pg_roles WHERE rolname IN ('salonpulse_runtime','salonpulse_migrator'))) THEN
        RAISE EXCEPTION 'Existing deployment roles have unexpected privileges; review manually';
    END IF;
END $$;
REVOKE ALL ON DATABASE salonpulse_prod FROM PUBLIC;
GRANT CONNECT ON DATABASE salonpulse_prod TO salonpulse_migrator, salonpulse_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM salonpulse_runtime;
GRANT USAGE ON SCHEMA public TO salonpulse_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO salonpulse_migrator;
-- The migrator sets its own default privileges during the atomic release.
-- No administrator membership/SET ROLE grant is needed for either app role.
COMMIT;
