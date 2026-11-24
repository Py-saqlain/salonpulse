"""Shared guarded, rollback-only local PostgreSQL fixture. No schema creation."""

import unittest

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.db.base import Base
import app.models


class LocalPostgresTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from app.core.config import Settings
        try:
            settings = Settings()
            if settings.database_url is None:
                raise ValueError
            url = make_url(settings.database_url.get_secret_value())
            if (url.drivername, url.username, url.database, url.port) != (
                "postgresql+psycopg", "salonpulse_app", "salonpulse_dev", 5432,
            ) or url.host not in {"localhost", "127.0.0.1", "::1"}:
                raise ValueError
            cls.engine = create_engine(url, poolclass=NullPool, echo=False, hide_parameters=True,
                                       connect_args={"connect_timeout": 5, "options": "-c statement_timeout=5000 -c lock_timeout=3000"})
            cls.addClassCleanup(cls.engine.dispose)
            with cls.engine.connect() as connection:
                connection.exec_driver_sql("SET TRANSACTION READ ONLY")
                if tuple(connection.execute(text("SELECT current_database(),current_user,inet_server_port()")).one()) != (
                    "salonpulse_dev", "salonpulse_app", 5432,
                ):
                    raise ValueError
                cls.baseline = cls.record_ids(connection)
                cls.index_oid = connection.execute(text(
                    "SELECT 'public.uq_services_business_active_name'::regclass::oid"
                )).scalar_one()
        except Exception:
            raise RuntimeError("Local database safety/connectivity check failed; private details suppressed") from None

    @classmethod
    def record_ids(cls, connection):
        return {name: set(connection.execute(table.select().with_only_columns(table.c.id)).scalars())
                for name, table in Base.metadata.tables.items()}

    @classmethod
    def tearDownClass(cls):
        with cls.engine.connect() as connection:
            connection.exec_driver_sql("SET TRANSACTION READ ONLY")
            if cls.record_ids(connection) != cls.baseline:
                raise AssertionError("Database record IDs changed after rollback-only tests")
            oid = connection.execute(text("SELECT 'public.uq_services_business_active_name'::regclass::oid")).scalar_one()
            if oid != cls.index_oid:
                raise AssertionError("Existing service index identity changed")

    def setUp(self):
        self.connection = self.engine.connect()
        self.addCleanup(self.connection.close)
        self.transaction = self.connection.begin()
        self.addCleanup(self.transaction.rollback)
        self.session = Session(bind=self.connection, join_transaction_mode="create_savepoint", expire_on_commit=False)
        self.addCleanup(self.session.close)
