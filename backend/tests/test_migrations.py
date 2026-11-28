"""Validate migrations using PostgreSQL compilation and mocked connections only."""

from pathlib import Path
import runpy
import unittest
from unittest.mock import MagicMock, patch

from alembic import context
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from alembic.util import CommandError
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, create_mock_engine
from sqlalchemy.schema import CreateIndex, CreateTable, DropTable

from app.db.base import Base
import app.models


BACKEND = Path(__file__).resolve().parents[1]


class MigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scripts = ScriptDirectory.from_config(Config(str(BACKEND / "alembic.ini")))
        # Pin this test to the initial revision, independent of later migrations.
        cls.revision = cls.scripts.get_revision("b56e17b6641d")
        cls.statements = []
        cls.engine = create_mock_engine(
            "postgresql+psycopg://", lambda sql, *args, **kwargs: cls.statements.append(sql),
        )
        migration = MigrationContext.configure(connection=cls.engine, opts={"target_metadata": Base.metadata})
        with Operations.context(migration):
            cls.revision.module.upgrade()
        cls.tables = {sql.element.name: sql.element for sql in cls.statements if isinstance(sql, CreateTable)}

    def sql(self, expression):
        return str(expression.compile(dialect=self.engine.dialect, compile_kwargs={"literal_binds": True}))

    def test_single_initial_revision_and_exact_table_coverage(self):
        self.assertEqual(len(self.scripts.get_heads()), 1)
        self.assertIsNone(self.revision.down_revision)
        self.assertEqual(self.revision.doc, "create initial salonpulse schema")
        self.assertEqual(set(self.tables), {"businesses", "customers", "staff", "services", "appointments"})
        self.assertEqual(len(self.tables), 5)
        self.assertTrue(all(isinstance(sql, (CreateTable, CreateIndex)) for sql in self.statements))

    def test_columns_types_nullability_and_server_defaults_match_models(self):
        for name, table in self.tables.items():
            expected = Base.metadata.tables[name]
            self.assertEqual(list(table.c.keys()), [key for key in expected.c.keys() if key not in {"hours", "description"}])
            for column in table.c:
                original = expected.c[column.name]
                with self.subTest(table=name, column=column.name):
                    self.assertEqual(str(column.type.compile(dialect=self.engine.dialect)),
                                     str(original.type.compile(dialect=self.engine.dialect)))
                    self.assertEqual(column.nullable, original.nullable)
                    self.assertEqual(column.primary_key, original.primary_key)
                    self.assertEqual(str(column.server_default.arg) if column.server_default else None,
                                     str(original.server_default.arg) if original.server_default else None)

    def test_all_constraints_and_composite_tenant_foreign_keys_match(self):
        def signature(constraint):
            common = (type(constraint).__name__, str(constraint.name))
            if isinstance(constraint, CheckConstraint):
                return common + (self.sql(constraint.sqltext),)
            if isinstance(constraint, ForeignKeyConstraint):
                return common + (tuple(constraint.column_keys),
                                 tuple(element.target_fullname for element in constraint.elements), constraint.ondelete)
            return common + (tuple(constraint.columns.keys()),)

        for name, table in self.tables.items():
            self.assertEqual({signature(item) for item in table.constraints},
                             {signature(item) for item in Base.metadata.tables[name].constraints
                              if str(item.name) not in {"ck_staff_hours_array", "ck_services_description_length", "uq_appointments_business_id"}}, name)

    def test_indexes_including_partial_expression_index_match(self):
        def index_sql(statement):
            sql = self.sql(statement)
            if statement.element.name == "uq_services_business_active_name":
                # The immutable initial revision uses equivalent trim(name).
                sql = sql.replace("lower(trim(name))", "lower(TRIM(BOTH FROM name))")
            return sql

        actual = {index_sql(statement) for statement in self.statements if isinstance(statement, CreateIndex)}
        expected = {index_sql(CreateIndex(index)) for name, table in Base.metadata.tables.items()
                    if name in self.tables for index in table.indexes if not str(index.name).endswith('_business_order')}
        self.assertEqual(actual, expected)
        self.assertEqual(len(actual), 9)
        self.assertTrue(any("lower(TRIM(BOTH FROM name))" in ddl and "WHERE active IS true" in ddl for ddl in actual))

    def test_postgresql_compilation_and_safe_reverse_dependency_order(self):
        for statement in self.statements:
            ddl = self.sql(statement)
            self.assertNotIn("CASCADE", ddl)
        statements = []
        engine = create_mock_engine("postgresql+psycopg://", lambda sql, *a, **kw: statements.append(sql))
        with Operations.context(MigrationContext.configure(connection=engine)):
            self.revision.module.downgrade()
        self.assertEqual([sql.element.name for sql in statements if isinstance(sql, DropTable)],
                         list(reversed(list(self.tables))))


class MigrationEnvironmentTests(unittest.TestCase):
    def run_environment(self, url="postgresql+psycopg://localhost/salonpulse_test", supplied=None):
        # Patch the settings singleton: never inspect private .env values.
        from app.core.config import Settings
        settings = Settings(_env_file=None, database_url=url, debug=False)
        config = Config(str(BACKEND / "alembic.ini"))
        config.attributes["read_only"] = True
        if supplied is not None:
            config.attributes["connection"] = supplied
        engine = MagicMock()
        with (
            patch("app.core.config.settings", settings),
            patch.object(context, "config", config, create=True),
            patch.object(context, "is_offline_mode", return_value=False),
            patch.object(context, "configure") as configure,
            patch.object(context, "begin_transaction"),
            patch.object(context, "run_migrations"),
            patch("logging.config.fileConfig"),
            patch("sqlalchemy.create_engine", return_value=engine) as create,
        ):
            runpy.run_path(str(BACKEND / "alembic" / "env.py"))
        return config, engine, create, configure

    def test_read_only_generation_and_metadata_comparison_configuration(self):
        _, engine, create, configure = self.run_environment()
        engine.connect.return_value.__enter__.return_value.exec_driver_sql.assert_called_once_with("SET TRANSACTION READ ONLY")
        self.assertTrue(configure.call_args.kwargs["dont_mutate"])
        self.assertIs(configure.call_args.kwargs["target_metadata"], Base.metadata)
        self.assertTrue(configure.call_args.kwargs["compare_type"])
        self.assertTrue(configure.call_args.kwargs["compare_server_default"])
        self.assertIn("alembic.ext.checkconstraint_byname", configure.call_args.kwargs["autogenerate_plugins"])
        self.assertTrue(create.call_args.kwargs["hide_parameters"])
        self.assertFalse(create.call_args.kwargs["echo"])
        engine.dispose.assert_called_once()

    def test_supplied_connection_remains_read_only_and_owned_by_caller(self):
        supplied=MagicMock()
        _,engine,create,configure=self.run_environment(supplied=supplied)
        create.assert_not_called();engine.dispose.assert_not_called()
        supplied.exec_driver_sql.assert_called_once_with('SET TRANSACTION READ ONLY')
        self.assertIs(configure.call_args.kwargs['connection'],supplied)
        self.assertTrue(configure.call_args.kwargs['dont_mutate'])

    def test_missing_or_wrong_driver_url_fails_safely(self):
        for url in [None, "sqlite:///test.db", "invalid URL"]:
            with self.subTest(url=url), self.assertRaises(CommandError) as caught:
                self.run_environment(url)
            self.assertNotIn(str(url), str(caught.exception))

    def test_ini_uses_absolute_resolved_paths_without_connection_url(self):
        config = Config(str(BACKEND / "alembic.ini"))
        self.assertIsNone(config.get_main_option("sqlalchemy.url"))
        self.assertEqual(Path(config.get_main_option("script_location")).resolve(), BACKEND / "alembic")
        self.assertEqual(Path(config.get_main_option("prepend_sys_path")).resolve(), BACKEND)


if __name__ == "__main__":
    unittest.main()
