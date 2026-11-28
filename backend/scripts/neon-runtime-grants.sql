-- Applied by the migration operator inside the migration transaction.
-- Table ownership stays with salonpulse_migrator; no runtime DDL or role grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, salonpulse_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, salonpulse_runtime;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, salonpulse_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    public.businesses, public.users, public.customers, public.staff,
    public.services, public.appointments, public.payment_intents TO salonpulse_runtime;
GRANT SELECT, INSERT ON public.payments, public.audit_logs TO salonpulse_runtime;
GRANT SELECT ON public.alembic_version TO salonpulse_runtime;
