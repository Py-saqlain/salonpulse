import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from pydantic import SecretStr
from sqlalchemy.exc import OperationalError

from test_config_cors import request
from app.core.config import Settings
from app.db.session import Database, DatabaseUnavailable, get_db
from app.main import create_app


# A noncredentialed URL for mocked tests only; no live PostgreSQL access.
TEST_URL = "postgresql+psycopg://localhost/salonpulse_test"


class DatabaseTests(unittest.TestCase):
    def test_missing_url_has_no_engine_and_safe_error(self):
        database = Database(None)
        with patch("app.db.session.create_engine") as create:
            with self.assertRaisesRegex(DatabaseUnavailable, "Database unavailable"):
                database.session_factory()
            create.assert_not_called()
        database.dispose()

    def test_invalid_url_and_wrong_driver_are_safe(self):
        for url in ["invalid URL", "sqlite:///test.db", "postgresql+psycopg2://localhost/db"]:
            with self.subTest(url=url), self.assertRaisesRegex(DatabaseUnavailable, "Database unavailable"):
                Database(SecretStr(url)).session_factory()

    def test_engine_is_lazy_reused_and_configured(self):
        with patch("app.db.session.create_engine") as create, patch("app.db.session.sessionmaker") as sessions:
            database = Database(SecretStr(TEST_URL))
            create.assert_not_called()
            self.assertIs(database.session_factory(), sessions.return_value)
            self.assertIs(database.session_factory(), sessions.return_value)
            create.assert_called_once()
            options = create.call_args.kwargs
            self.assertTrue(options["pool_pre_ping"])
            self.assertEqual(options["pool_size"], 5)
            self.assertEqual(options["max_overflow"], 5)
            self.assertEqual(options["pool_timeout"], 5)
            self.assertEqual(options["connect_args"]["connect_timeout"], 5)
            self.assertTrue(options["hide_parameters"])
            self.assertFalse(options["echo"])
            sessions.assert_called_once_with(bind=create.return_value, autoflush=False, expire_on_commit=False)
            database.dispose()
            create.return_value.dispose.assert_called_once()

    def test_real_driver_and_engine_initialize_without_connecting(self):
        database = Database(SecretStr(TEST_URL))
        try:
            with patch("psycopg.connect") as connect:
                factory = database.session_factory()
                with factory() as session:
                    self.assertEqual(session.get_bind().dialect.name, "postgresql")
                    self.assertEqual(session.get_bind().dialect.driver, "psycopg")
                connect.assert_not_called()
        finally:
            database.dispose()

    def test_dependency_exits_session_context_on_success(self):
        context = MagicMock()
        database = MagicMock()
        database.session_factory.return_value.return_value = context
        dependency = get_db(SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=database))))
        self.assertIs(next(dependency), context.__enter__.return_value)
        with self.assertRaises(StopIteration):
            next(dependency)
        context.__exit__.assert_called_once_with(None, None, None)

    def test_dependency_exits_session_and_hides_database_errors(self):
        context = MagicMock()
        context.__exit__.return_value = False
        database = MagicMock()
        database.session_factory.return_value.return_value = context
        dependency = get_db(SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=database))))
        next(dependency)
        failure = OperationalError("SELECT 1", {}, Exception("private connection details"))
        with self.assertRaises(HTTPException) as caught:
            dependency.throw(failure)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.detail, "Database unavailable")
        context.__exit__.assert_called_once()


class DatabaseHealthTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        with patch.dict(os.environ, {}, clear=True):
            self.config = Settings(_env_file=None)
        self.app = create_app(self.config)

    async def test_missing_configuration_returns_503(self):
        status, headers, body = await request(self.app, path="/health/db", origin="http://localhost:5173")
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body), {"detail": "Database unavailable"})
        self.assertEqual(headers["access-control-allow-origin"], "http://localhost:5173")
        self.assertEqual((await request(self.app))[0], 200)

    async def test_success_uses_select_one_and_override_is_closed(self):
        session = MagicMock()
        session.execute.return_value.scalar_one.return_value = 1
        closed = []

        def override():
            try:
                yield session
            finally:
                closed.append(True)

        self.app.dependency_overrides[get_db] = override
        status, _, body = await request(self.app, path="/health/db")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"status": "ok"})
        self.assertEqual(str(session.execute.call_args.args[0]), "SELECT 1")
        self.assertEqual(closed, [True])

    async def test_connection_failure_never_exposes_details_even_in_debug(self):
        self.app = create_app(self.config.model_copy(update={"debug": True}))
        session = MagicMock()
        session.execute.side_effect = OperationalError("SELECT 1", {}, Exception("private connection details"))
        self.app.dependency_overrides[get_db] = lambda: session
        status, _, body = await request(self.app, path="/health/db")
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body), {"detail": "Database unavailable"})
        self.assertNotIn(b"private", body)

    async def test_invalid_query_result_returns_503(self):
        session = MagicMock()
        session.execute.return_value.scalar_one.return_value = 0
        self.app.dependency_overrides[get_db] = lambda: session
        self.assertEqual((await request(self.app, path="/health/db"))[0], 503)

    async def test_engine_configuration_error_is_safe(self):
        self.app = create_app(self.config.model_copy(update={"database_url": SecretStr("invalid URL")}))
        status, _, body = await request(self.app, path="/health/db")
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body), {"detail": "Database unavailable"})

    async def test_lifespan_disposes_pool(self):
        with patch.object(self.app.state.database, "dispose") as dispose:
            async with self.app.router.lifespan_context(self.app):
                dispose.assert_not_called()
            dispose.assert_called_once()

    def test_database_url_is_loaded_and_masked(self):
        with patch.dict(os.environ, {"DATABASE_URL": TEST_URL}, clear=True):
            config = Settings(_env_file=None)
        self.assertEqual(config.database_url.get_secret_value(), TEST_URL)
        self.assertNotIn(TEST_URL, repr(config))


if __name__ == "__main__":
    unittest.main()
