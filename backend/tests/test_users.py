"""User model/migration checks: no database connections or user accounts."""

from pathlib import Path
import unittest
from uuid import UUID, uuid4

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, UniqueConstraint, create_mock_engine, inspect
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateIndex, CreateTable, DropIndex, DropTable

from app.db.base import Base
from app.models import Business, Staff, User, UserRole


class UserModelTests(unittest.TestCase):
    def setUp(self):
        self.table = User.__table__
        self.dialect = postgresql.dialect()

    def test_required_fields_uuid_and_timestamps(self):
        self.assertIs(Base.metadata.tables["users"], self.table)
        self.assertEqual(set(self.table.c.keys()), {
            "id", "business_id", "full_name", "email", "password_hash", "role", "is_active", "created_at", "updated_at",
        })
        for column in self.table.c:
            self.assertFalse(column.nullable, column.name)
        self.assertTrue(self.table.c.id.primary_key)
        self.assertTrue(self.table.c.id.type.as_uuid)
        self.assertIsInstance(self.table.c.id.default.arg(None), UUID)
        for name in ("created_at", "updated_at"):
            self.assertTrue(self.table.c[name].type.timezone)
            self.assertIsNotNone(self.table.c[name].server_default)
        self.assertIsNotNone(self.table.c.updated_at.onupdate)

    def test_business_relationship_and_login_identity_separate_from_staff(self):
        business = Business(id=uuid4(), name="Model test salon")
        user = User(business=business, full_name="Owner", email="owner@example.test")
        self.assertIs(user.business, business)
        self.assertIn(user, business.users)
        relation = inspect(User).relationships.business
        self.assertEqual(relation.back_populates, "users")
        self.assertFalse(relation.uselist)
        self.assertEqual(set(inspect(User).relationships.keys()), {"business"})
        self.assertIsNot(User.__table__, Staff.__table__)
        self.assertNotIn("user_id", Staff.__table__.c)

    def test_business_fk_restricts_deletion_without_orm_delete_cascade(self):
        fk = next(iter(self.table.foreign_key_constraints))
        self.assertEqual(fk.column_keys, ["business_id"])
        self.assertEqual([element.target_fullname for element in fk.elements], ["businesses.id"])
        self.assertEqual(fk.ondelete, "RESTRICT")
        users = inspect(Business).relationships.users
        self.assertEqual(users.passive_deletes, "all")
        self.assertNotIn("delete", users.cascade)
        self.assertNotIn("delete-orphan", users.cascade)

    def test_email_normalizes_on_creation_and_edit(self):
        user = User(email="  Owner@Example.Test  ")
        self.assertEqual(user.email, "owner@example.test")
        user.email = "  EDITED@Example.Test "
        self.assertEqual(user.email, "edited@example.test")
        for value in ("", " ", "\t\n"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                user.email = value

    def test_email_case_insensitive_unique_index_is_global_without_redundancy(self):
        self.assertEqual({str(index.name) for index in self.table.indexes}, {"uq_users_email", "ix_users_business_id"})
        unique = next(index for index in self.table.indexes if index.name == "uq_users_email")
        self.assertTrue(unique.unique)
        self.assertEqual(len(unique.expressions), 1)
        self.assertEqual(str(CreateIndex(unique).compile(dialect=self.dialect)),
                         "CREATE UNIQUE INDEX uq_users_email ON users (lower(email))")
        self.assertIsNone(unique.dialect_options["postgresql"]["where"])
        self.assertFalse(any(isinstance(item, UniqueConstraint) and "email" in item.columns for item in self.table.constraints))
        self.assertTrue(any(isinstance(item, UniqueConstraint) and set(item.columns.keys()) == {"business_id", "id"} for item in self.table.constraints))
        business_index = next(index for index in self.table.indexes if index.name == "ix_users_business_id")
        self.assertFalse(business_index.unique)
        self.assertEqual(list(business_index.columns.keys()), ["business_id"])

    def test_nonblank_and_normalized_email_checks_are_database_constraints(self):
        checks = {str(item.sqltext) for item in self.table.constraints if isinstance(item, CheckConstraint)}
        self.assertIn("length(trim(full_name)) > 0", checks)
        self.assertIn("length(trim(password_hash)) > 0", checks)
        self.assertIn("length(trim(email)) > 0 AND email = lower(trim(email))", checks)

    def test_owner_default_active_default_and_validated_role_values(self):
        self.assertEqual(self.table.c.role.default.arg, UserRole.OWNER)
        self.assertEqual(self.table.c.role.server_default.arg, "owner")
        self.assertTrue(self.table.c.is_active.default.arg)
        self.assertEqual(str(self.table.c.is_active.server_default.arg), "true")
        self.assertEqual(set(self.table.c.role.type.enums), {"owner", "staff"})
        self.assertTrue(self.table.c.role.type.validate_strings)
        self.assertTrue(self.table.c.role.type.create_constraint)
        for value in (UserRole.OWNER, UserRole.STAFF, "owner", "staff"):
            self.assertIsInstance(User(role=value).role, UserRole)
        for value in ("admin", "superuser", "OWNER", "", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                User(role=value)
        with self.assertRaises(LookupError):
            self.table.c.role.type.bind_processor(self.dialect)("admin")
        ddl = str(CreateTable(self.table).compile(dialect=self.dialect))
        self.assertIn("CONSTRAINT ck_users_user_role CHECK (role IN ('owner', 'staff'))", ddl)

    def test_model_has_no_plaintext_password_field_or_default_credentials(self):
        self.assertNotIn("password", self.table.c)
        self.assertIsNone(self.table.c.password_hash.default)
        self.assertIsNone(self.table.c.password_hash.server_default)
        with self.assertRaises(TypeError):
            User(password="not accepted")


class UserMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        scripts = ScriptDirectory.from_config(Config(str(Path(__file__).resolve().parents[1] / "alembic.ini")))
        cls.revision = scripts.get_revision("6d7519d70bb2")
        cls.heads = scripts.get_heads()
        cls.statements = []
        cls.engine = create_mock_engine("postgresql+psycopg://", lambda sql, *a, **kw: cls.statements.append(sql))
        migration = MigrationContext.configure(connection=cls.engine, opts={"target_metadata": Base.metadata})
        with Operations.context(migration):
            cls.revision.module.upgrade()

    def sql(self, expression):
        return str(expression.compile(dialect=self.engine.dialect, compile_kwargs={"literal_binds": True}))

    def test_revision_depends_on_initial_and_is_the_only_head(self):
        self.assertEqual(self.revision.down_revision, "b56e17b6641d")
        self.assertEqual(self.revision.doc, "add users table")
        self.assertEqual(self.heads, ["1deb66be8c11"])

    def test_upgrade_only_creates_users_and_its_two_indexes(self):
        self.assertEqual([type(statement) for statement in self.statements], [CreateTable, CreateIndex, CreateIndex])
        self.assertEqual(self.statements[0].element.name, "users")
        for statement in self.statements[1:]:
            self.assertEqual(statement.element.table.name, "users")
        actual_indexes = {self.sql(statement) for statement in self.statements if isinstance(statement, CreateIndex)}
        self.assertEqual(actual_indexes, {self.sql(CreateIndex(index)) for index in User.__table__.indexes})
        for statement in self.statements:
            self.assertNotIn("CASCADE", self.sql(statement))

    def test_user_migration_columns_and_defaults_match_model(self):
        migrated = self.statements[0].element
        expected = User.__table__
        self.assertEqual(list(migrated.c.keys()), list(expected.c.keys()))
        for column in migrated.c:
            original = expected.c[column.name]
            with self.subTest(column=column.name):
                self.assertEqual(str(column.type.compile(dialect=self.engine.dialect)),
                                 str(original.type.compile(dialect=self.engine.dialect)))
                self.assertEqual(column.nullable, original.nullable)
                self.assertEqual(column.primary_key, original.primary_key)
                self.assertEqual(str(column.server_default.arg) if column.server_default else None,
                                 str(original.server_default.arg) if original.server_default else None)

    def test_user_migration_checks_and_fk_match_model(self):
        def signature(constraint):
            result = (type(constraint).__name__, str(constraint.name))
            if isinstance(constraint, CheckConstraint):
                return result + (self.sql(constraint.sqltext),)
            if isinstance(constraint, ForeignKeyConstraint):
                return result + (tuple(constraint.column_keys),
                                 tuple(element.target_fullname for element in constraint.elements), constraint.ondelete)
            return result + (tuple(constraint.columns.keys()),)
        self.assertEqual({signature(c) for c in self.statements[0].element.constraints},
                         {signature(c) for c in User.__table__.constraints if str(c.name) != "uq_users_business_id"})

    def test_downgrade_definition_only_targets_users_without_execution(self):
        statements = []
        engine = create_mock_engine("postgresql+psycopg://", lambda sql, *a, **kw: statements.append(sql))
        with Operations.context(MigrationContext.configure(connection=engine)):
            self.revision.module.downgrade()
        self.assertEqual([type(sql) for sql in statements], [DropIndex, DropIndex, DropTable])
        self.assertEqual(statements[-1].element.name, "users")
        self.assertEqual({sql.element.table.name for sql in statements[:-1]}, {"users"})


if __name__ == "__main__":
    unittest.main()
