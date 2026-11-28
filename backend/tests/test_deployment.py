"""Deployment guards never connect to hosting or change local role privileges."""
import json
import io
from contextlib import redirect_stderr
import secrets
import unittest
from unittest.mock import MagicMock, patch

from pydantic import SecretStr
from app import deployment as deploy


class DeploymentTests(unittest.TestCase):
    def url(self, role='salonpulse_migrator', host='ep-release.aws.neon.tech', database='salonpulse_prod'):
        return SecretStr('postgresql+psycopg://' + role + ':' + secrets.token_urlsafe(24)
                         + '@' + host + '/' + database + '?sslmode=verify-full&sslrootcert=system')

    def test_only_the_reviewed_neon_direct_target_and_role_are_accepted(self):
        host='ep-release.aws.neon.tech'
        self.assertEqual(deploy.target_url(self.url(),host,'salonpulse_prod','salonpulse_migrator').host,host)
        for value,expected_host in [(self.url(host='localhost'),'localhost'),
                (self.url(host='ep-release-pooler.aws.neon.tech'),'ep-release-pooler.aws.neon.tech'),
                (self.url(database='salonpulse_dev'),host),(self.url(role='salonpulse_runtime'),host),
                (self.url(), 'ep-other.aws.neon.tech'),
                (SecretStr(self.url().get_secret_value().replace('verify-full','require')),host)]:
            with self.assertRaises(deploy.DeploymentError):
                deploy.target_url(value,expected_host,'salonpulse_prod','salonpulse_migrator')

    def test_role_guards_reject_admin_memberships_and_inheritance(self):
        connection=MagicMock()
        connection.execute.return_value.one.return_value=('salonpulse_runtime',False,False,False,False,False,False)
        connection.scalar.return_value=False
        deploy.require_limited_role(connection,'salonpulse_runtime')
        connection.scalar.return_value=True
        with self.assertRaises(deploy.DeploymentError):deploy.require_limited_role(connection,'salonpulse_runtime')
        connection.scalar.return_value=False
        connection.execute.return_value.one.return_value=('salonpulse_runtime',False,False,False,False,False,True)
        with self.assertRaises(deploy.DeploymentError):deploy.require_limited_role(connection,'salonpulse_runtime')

    def test_runtime_policy_rejects_financial_mutation_and_runtime_table_ownership(self):
        connection=MagicMock()
        def scalar(statement, params=None):
            sql=str(statement)
            if 'pg_get_userbyid' in sql:return 'salonpulse_migrator'
            if 'has_table_privilege' in sql:
                table=params['t'].split('.')[1]
                allowed={'SELECT'} if table=='alembic_version' else {'SELECT','INSERT'} if table in deploy.APPEND_ONLY else {'SELECT','INSERT','UPDATE','DELETE'}
                return params['p'] in allowed
            return False
        connection.scalar.side_effect=scalar
        with patch.object(deploy,'require_limited_role'):
            deploy.runtime_policy(connection)
            connection.scalar.side_effect=lambda statement, params=None: True if params=={'t':'public.payments','p':'UPDATE'} else scalar(statement,params)
            with self.assertRaises(deploy.DeploymentError):deploy.runtime_policy(connection)
            connection.scalar.side_effect=lambda statement, params=None: 'salonpulse_runtime' if 'pg_get_userbyid' in str(statement) else scalar(statement,params)
            with self.assertRaises(deploy.DeploymentError):deploy.runtime_policy(connection)

    def test_migration_rejects_unexpected_revision_before_upgrade_and_disposes(self):
        config=deploy.MigrationSettings(migration_database_url=self.url(),deploy_database_host='ep-release.aws.neon.tech')
        engine=MagicMock()
        with patch.object(deploy,'create_engine',return_value=engine),patch.object(deploy,'require_limited_role'),patch.object(deploy,'revision',return_value='unexpected'),patch.object(deploy.command,'upgrade') as upgrade:
            with self.assertRaises(deploy.DeploymentError):deploy.migrate(config,'empty')
            upgrade.assert_not_called();engine.dispose.assert_called_once()

    def test_migrations_and_grants_share_a_transaction_then_check_read_only(self):
        config=deploy.MigrationSettings(migration_database_url=self.url(),deploy_database_host='ep-release.aws.neon.tech')
        engine=MagicMock();connection=engine.begin.return_value.__enter__.return_value
        with patch.object(deploy,'create_engine',return_value=engine),patch.object(deploy,'require_limited_role'),patch.object(deploy,'revision',return_value='empty'),patch.object(deploy.command,'upgrade') as upgrade,patch.object(deploy.command,'check') as check:
            deploy.migrate(config,'empty')
            self.assertIs(upgrade.call_args.args[0].attributes['connection'],connection)
            self.assertTrue(any('GRANT SELECT, INSERT ON public.payments' in call.args[0] for call in connection.exec_driver_sql.call_args_list))
            self.assertTrue(check.call_args.args[0].attributes['read_only'])
            self.assertEqual(engine.begin.call_count,2)
            engine.dispose.assert_called_once()

    def test_render_configuration_does_not_automate_migrations_or_share_credentials(self):
        config=json.loads((deploy.BACKEND.parent/'render.yaml').read_text())['services'][0]
        self.assertEqual(config['rootDir'],'backend');self.assertEqual(config['plan'],'free')
        self.assertEqual(config['autoDeployTrigger'],'off');self.assertNotIn('preDeployCommand',config)
        self.assertNotIn('healthCheckPath',config)  # Default TCP probe; no HTTP/HTTPS exemption.
        self.assertIn('check-runtime && python -m app.serve',config['startCommand'])
        variables={v['key']:v for v in config['envVars']}
        self.assertNotIn('MIGRATION_DATABASE_URL',variables)
        self.assertFalse(variables['DATABASE_URL']['sync']);self.assertFalse(variables['JWT_SECRET_KEY']['sync'])

    def test_bootstrap_refuses_existing_tables_and_never_contains_a_password(self):
        sql=(deploy.BACKEND/'scripts/neon-bootstrap.sql').read_text()
        self.assertIn("current_database() <> 'salonpulse_prod'",sql)
        self.assertIn('Expected a new empty deployment schema',sql)
        self.assertNotIn('PASSWORD ',sql)
        for denied in ('NOSUPERUSER','NOCREATEDB','NOCREATEROLE','NOREPLICATION','NOBYPASSRLS','NOINHERIT'):
            self.assertIn(denied,sql)

    def test_cli_redacts_configuration_and_database_exception_details(self):
        private=secrets.token_urlsafe(32);output=io.StringIO()
        with patch.object(deploy,'check_runtime',side_effect=RuntimeError(private)),redirect_stderr(output):
            self.assertEqual(deploy.main(['check-runtime']),78)
        self.assertNotIn(private,output.getvalue());self.assertIn('Deployment verification failed',output.getvalue())

    def test_migration_cli_refuses_the_existing_private_development_file(self):
        with patch.object(deploy,'migrate') as migrate,redirect_stderr(io.StringIO()):
            self.assertEqual(deploy.main(['migrate','--env-file',str(deploy.BACKEND/'.env'),'--expected-revision','empty']),78)
        migrate.assert_not_called()
