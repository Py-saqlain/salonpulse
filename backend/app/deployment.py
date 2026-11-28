"""Explicit deployment checks/migrations. Never invoked by application imports."""
import argparse
from pathlib import Path
import sys

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import create_engine, inspect, pool, text
from sqlalchemy.engine import make_url

BACKEND = Path(__file__).resolve().parents[1]
TABLES = {'businesses', 'users', 'customers', 'staff', 'services', 'appointments',
          'payments', 'payment_intents', 'audit_logs'}
APPEND_ONLY = {'payments', 'audit_logs'}


class DeploymentError(Exception):
    pass


class MigrationSettings(BaseSettings):
    model_config = SettingsConfigDict(extra='ignore', hide_input_in_errors=True, env_file_encoding='utf-8')
    migration_database_url: SecretStr
    deploy_database_host: str = Field(min_length=1)
    deploy_database_name: str = 'salonpulse_prod'


def target_url(value, host, database, role):
    """Exact operator-selected Neon target; no development/local/pooler fallback."""
    url = make_url(value.get_secret_value())
    if (url.drivername != 'postgresql+psycopg' or url.host != host
            or not host.endswith('.neon.tech') or '-pooler' in host
            or url.database != database or database != 'salonpulse_prod'
            or url.username != role or len(url.password or '') < 16 or len(set(url.password or '')) < 8
            or url.query.get('sslmode') != 'verify-full' or not url.query.get('sslrootcert')
            or 'options' in url.query):
        raise DeploymentError()
    return url


def migration_config(connection):
    config = Config(str(BACKEND / 'alembic.ini'))
    config.attributes.update(connection=connection, skip_logging_configuration=True)
    return config


def require_limited_role(connection, role):
    actual = connection.execute(text('''SELECT current_user, rolsuper, rolcreatedb,
        rolcreaterole, rolreplication, rolbypassrls, rolinherit FROM pg_roles
        WHERE rolname = current_user''')).one()
    if actual[0] != role or any(actual[1:]):
        raise DeploymentError()
    if connection.scalar(text('''SELECT EXISTS (SELECT 1 FROM pg_auth_members
        WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user))''')):
        raise DeploymentError()


def runtime_policy(connection):
    require_limited_role(connection, 'salonpulse_runtime')
    for privilege in ('CREATE', 'TEMP'):
        if connection.scalar(text('SELECT has_database_privilege(current_user,current_database(),:p)'), {'p': privilege}):
            raise DeploymentError()
    if connection.scalar(text("SELECT has_schema_privilege(current_user,'public','CREATE')")):
        raise DeploymentError()
    for table in TABLES | {'alembic_version'}:
        owner = connection.scalar(text('''SELECT pg_get_userbyid(c.relowner) FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=:t'''), {'t': table})
        if owner != 'salonpulse_migrator':
            raise DeploymentError()
        allowed = {'SELECT'} if table == 'alembic_version' else {'SELECT', 'INSERT'} if table in APPEND_ONLY else {'SELECT', 'INSERT', 'UPDATE', 'DELETE'}
        for privilege in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'):
            granted = connection.scalar(text('SELECT has_table_privilege(current_user,:t,:p)'), {'t': 'public.' + table, 'p': privilege})
            if bool(granted) != (privilege in allowed):
                raise DeploymentError()


def revision(connection):
    tables = set(inspect(connection).get_table_names(schema='public'))
    if 'alembic_version' not in tables:
        if tables:
            raise DeploymentError()
        return 'empty'
    if tables != TABLES | {'alembic_version'}:
        raise DeploymentError()
    rows = connection.scalars(text('SELECT version_num FROM public.alembic_version')).all()
    if len(rows) != 1:
        raise DeploymentError()
    return rows[0]


def migrate(config, expected):
    url = target_url(config.migration_database_url, config.deploy_database_host,
                     config.deploy_database_name, 'salonpulse_migrator')
    engine = create_engine(url, poolclass=pool.NullPool, echo=False, hide_parameters=True,
                           connect_args={'connect_timeout': 10})
    try:
        with engine.begin() as connection:
            require_limited_role(connection, 'salonpulse_migrator')
            connection.exec_driver_sql('SET LOCAL search_path=public')
            connection.exec_driver_sql("SET LOCAL lock_timeout='5s'")
            connection.exec_driver_sql("SET LOCAL statement_timeout='60s'")
            if not connection.scalar(text('SELECT pg_try_advisory_xact_lock(739115042)')):
                raise DeploymentError()
            if revision(connection) != expected:
                raise DeploymentError()
            command.upgrade(migration_config(connection), 'head')
            connection.exec_driver_sql((BACKEND / 'scripts/neon-runtime-grants.sql').read_text(encoding='utf-8'))
        with engine.begin() as connection:
            check = migration_config(connection)
            check.attributes['read_only'] = True
            command.check(check)
        print('Migration and runtime grants completed; schema comparison passed.')
    finally:
        engine.dispose()


def check_runtime():
    from app.core.config import settings
    import os
    if not settings.production or not settings.trusted_proxies:
        raise DeploymentError()
    url = target_url(settings.database_url, os.environ.get('DEPLOY_DATABASE_HOST', ''),
                     os.environ.get('DEPLOY_DATABASE_NAME', ''), 'salonpulse_runtime')
    engine = create_engine(url, poolclass=pool.NullPool, echo=False, hide_parameters=True,
                           connect_args={'connect_timeout': 10, 'options': '-c statement_timeout=5000'})
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql('SET TRANSACTION READ ONLY')
            runtime_policy(connection)
            scripts = ScriptDirectory.from_config(Config(str(BACKEND / 'alembic.ini')))
            if revision(connection) != scripts.get_current_head():
                raise DeploymentError()
        print('Runtime configuration, role permissions and migration head verified.')
    finally:
        engine.dispose()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Guarded Neon release checks; no credentials on the command line.')
    parser.add_argument('operation', choices=['check-runtime', 'migrate'])
    parser.add_argument('--env-file', type=Path, help='Private migration settings file, never the development .env')
    parser.add_argument('--expected-revision', help='Reviewed current revision, or empty for the first release')
    args = parser.parse_args(argv)
    try:
        if args.operation == 'migrate':
            if not args.expected_revision or (args.env_file and args.env_file.resolve() == BACKEND / '.env'):
                raise DeploymentError()
            migrate(MigrationSettings(_env_file=args.env_file), args.expected_revision)
        else:
            check_runtime()
        return 0
    except Exception:
        # Configuration/driver exceptions can contain connection strings or SQL.
        print('Deployment verification failed; check target, credentials, role grants, proxy settings and revision privately.', file=sys.stderr)
        return 78


if __name__ == '__main__':
    raise SystemExit(main())
