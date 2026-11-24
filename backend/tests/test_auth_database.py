"""Real endpoint/database tests, with registration commits enclosed by rollback."""

import asyncio
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import event, func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from db_support import LocalPostgresTestCase
from test_auth import auth_config, post
from app.db.session import get_db
from app.core.security import decode_access_token, verify_password
from app.main import create_app
from app.models import Business, User, UserRole
from app.schemas.auth import RegisterRequest
from app.services.auth import DuplicateEmail, register_owner


class CommitConflictTests(unittest.TestCase):
    def test_commit_time_unique_conflict_from_concurrent_registration_is_translated(self):
        session = MagicMock()
        added = []
        session.add.side_effect = added.append

        def flush():
            for record in added:
                if record.id is None:
                    record.id = uuid4()
        session.flush.side_effect = flush
        original = Exception("simulated database conflict")
        original.sqlstate = "23505"
        original.diag = SimpleNamespace(constraint_name="uq_users_email")
        session.begin.return_value.__exit__.side_effect = IntegrityError("COMMIT", {}, original)
        payload = RegisterRequest(business_name="Test", full_name="Owner", email="owner@example.com",
                                  password="temporary test password")
        with patch("app.services.auth.hash_password", return_value="test-only-hash"), self.assertRaises(DuplicateEmail):
            register_owner(session, payload)
        self.assertEqual(session.flush.call_count, 2)
        session.begin.return_value.__exit__.assert_called_once()


@unittest.skipUnless(os.environ.get("SALONPULSE_RUN_DB_TESTS") == "1", "local PostgreSQL tests require explicit opt-in")
class AuthDatabaseTests(LocalPostgresTestCase):
    def setUp(self):
        super().setUp()
        self.config = auth_config()
        self.app = create_app(self.config)

        def override():
            try:
                # register_owner commits this savepoint, never the outer transaction.
                with Session(bind=self.connection, join_transaction_mode="create_savepoint", expire_on_commit=False) as session:
                    yield session
            except SQLAlchemyError:
                raise HTTPException(503, "Database unavailable") from None
        self.app.dependency_overrides[get_db] = override

    def payload(self, **overrides):
        values = {"business_name": "  Integration Salon  ", "full_name": "  Owner  ",
                  "email": f"auth-{uuid4().hex}@example.com", "password": "temporary test password"}
        values.update(overrides)
        return values

    def post(self, path, payload):
        status, headers, body = asyncio.run(post(self.app, path, payload))
        return status, headers, json.loads(body)

    def counts(self):
        return tuple(self.connection.scalar(select(func.count()).select_from(model)) for model in (Business, User))

    def test_successful_atomic_registration_and_login_store_only_hash_and_return_only_public_data(self):
        before = self.counts()
        payload = self.payload(email=f"Owner-{uuid4().hex}@Example.com")
        status, _, user = self.post("/api/auth/register", payload)
        self.assertEqual(status, 201)
        self.assertEqual(user["email"], payload["email"].lower())
        self.assertEqual(user["role"], "owner")
        self.assertEqual(user["full_name"], "Owner")
        self.assertTrue(user["is_active"])
        self.assertNotIn("password_hash", user)
        self.assertNotIn("password", user)
        self.assertEqual(self.counts(), (before[0] + 1, before[1] + 1))
        stored = self.session.get(User, UUID(user["id"]))
        self.assertTrue(stored.password_hash.startswith("$argon2id$"))
        self.assertNotEqual(stored.password_hash, payload["password"])
        self.assertTrue(verify_password(payload["password"], stored.password_hash))
        self.assertEqual(stored.business.name, "Integration Salon")
        status, headers, response = self.post("/api/auth/login", {"email": " " + payload["email"].upper() + " ",
                                                                "password": payload["password"]})
        self.assertEqual(status, 200)
        self.assertEqual(response["token_type"], "bearer")
        self.assertEqual(decode_access_token(response["access_token"], self.config), stored.id)
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertNotIn(stored.password_hash, json.dumps(response))
        self.assertNotIn(payload["password"], json.dumps(response))

    def test_duplicate_email_rolls_back_new_business_instead_of_creating_orphan(self):
        payload = self.payload()
        self.assertEqual(self.post("/api/auth/register", payload)[0], 201)
        before = self.counts()
        status, _, response = self.post("/api/auth/register", {**payload, "email": " " + payload["email"].upper() + " "})
        self.assertEqual(status, 409)
        self.assertEqual(response, {"detail": "Email already registered"})
        self.assertEqual(self.counts(), before)

    def test_unknown_wrong_password_and_inactive_users_have_identical_errors(self):
        payload = self.payload()
        status, _, response = self.post("/api/auth/register", payload)
        self.assertEqual(status, 201)
        wrong = self.post("/api/auth/login", {"email": payload["email"], "password": "wrong password"})
        unknown = self.post("/api/auth/login", {"email": f"absent-{uuid4().hex}@example.com", "password": payload["password"]})
        user = self.session.get(User, UUID(response["id"]))
        user.is_active = False
        self.session.flush()
        inactive = self.post("/api/auth/login", {"email": payload["email"], "password": payload["password"]})
        for status, headers, body in (wrong, unknown, inactive):
            self.assertEqual(status, 401)
            self.assertEqual(headers["www-authenticate"], "Bearer")
            self.assertEqual(body, {"detail": "Invalid email or password"})

    def test_either_insert_failure_rolls_back_registration_and_hides_database_details(self):
        before = self.counts()

        def fail_user_insert(mapper, connection, target):
            raise IntegrityError("private internal SQL", {}, Exception("private internal details"))
        for model in (Business, User):
            with self.subTest(failing_model=model.__name__):
                event.listen(model, "before_insert", fail_user_insert)
                try:
                    status, _, response = self.post("/api/auth/register", self.payload())
                finally:
                    event.remove(model, "before_insert", fail_user_insert)
                self.assertEqual(status, 503)
                self.assertEqual(response, {"detail": "Database unavailable"})
                self.assertEqual(self.counts(), before)

    def test_invalid_registration_and_public_role_fields_do_not_write_anything(self):
        before = self.counts()
        for fields in (dict(role="staff"), dict(role="owner"), dict(business_id=str(uuid4())),
                       dict(password="short"), dict(email="invalid")):
            self.assertEqual(self.post("/api/auth/register", self.payload(**fields))[0], 422)
        self.assertEqual(self.counts(), before)

    def test_password_whitespace_is_preserved_and_invalid_stored_hash_fails_safely(self):
        payload = self.payload(password="  whitespace password  ")
        status, _, response = self.post("/api/auth/register", payload)
        self.assertEqual(status, 201)
        self.assertEqual(self.post("/api/auth/login", {"email": payload["email"], "password": payload["password"]})[0], 200)
        self.assertEqual(self.post("/api/auth/login", {"email": payload["email"], "password": payload["password"].strip()})[0], 401)
        user = self.session.get(User, UUID(response["id"]))
        user.password_hash = "!invalid-test-hash"
        self.session.flush()
        self.assertEqual(self.post("/api/auth/login", {"email": payload["email"], "password": payload["password"]})[0], 401)


if __name__ == "__main__":
    unittest.main()
