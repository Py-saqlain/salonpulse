import base64
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import secrets
import tempfile
from typing import Annotated
import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

from fastapi import Depends
import jwt
from pydantic import SecretStr, ValidationError

from test_config_cors import request
from app.api.dependencies import get_current_user
from app.core.config import Settings
from app.core.security import (
    AuthenticationUnavailable, InvalidAccessToken, create_access_token, decode_access_token,
    hash_password, verify_password,
)
from app.db.session import get_db
from app.main import create_app
from app.models import User, UserRole
from app.schemas.auth import LoginRequest, RegisterRequest, UserResponse
from scripts.configure_jwt import configure


def auth_config(**overrides):
    with patch.dict(os.environ, {}, clear=True):
        return Settings(_env_file=None, jwt_secret_key=SecretStr(secrets.token_urlsafe(32)), **overrides)


async def post(app, path, payload):
    return await request(app, method="POST", path=path, extra_headers=[("Content-Type", "application/json")],
                         body=json.dumps(payload).encode())


class PasswordAndTokenTests(unittest.TestCase):
    def setUp(self):
        self.config = auth_config()
        self.subject = uuid4()

    def test_argon2id_salted_hashes_and_password_verification(self):
        first = hash_password("test password with spaces")
        second = hash_password("test password with spaces")
        self.assertTrue(first.startswith("$argon2id$"))
        self.assertNotEqual(first, second)
        self.assertTrue(verify_password("test password with spaces", first))
        self.assertFalse(verify_password("wrong password", first))
        self.assertFalse(verify_password("test password with spaces ", first))
        for malformed in ("not-a-hash", "$argon2id$malformed", ""):
            self.assertFalse(verify_password("password", malformed))

    def test_access_token_claims_expiry_and_subject(self):
        token = create_access_token(self.subject, self.config)
        self.assertEqual(decode_access_token(token, self.config), self.subject)
        claims = jwt.decode(token, self.config.jwt_secret_key.get_secret_value(), algorithms=["HS256"])
        self.assertEqual(set(claims), {"sub", "iat", "exp"})
        self.assertEqual(claims["exp"] - claims["iat"], 30 * 60)
        config = self.config.model_copy(update={"access_token_expire_minutes": 5})
        claims = jwt.decode(create_access_token(self.subject, config), config.jwt_secret_key.get_secret_value(), algorithms=["HS256"])
        self.assertEqual(claims["exp"] - claims["iat"], 5 * 60)

    def test_invalid_signature_tampered_payload_and_malformed_tokens(self):
        token = create_access_token(self.subject, self.config)
        with self.assertRaises(InvalidAccessToken):
            decode_access_token(token, auth_config())
        parts = token.split(".")
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=="))
        payload["sub"] = str(uuid4())
        parts[1] = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
        for invalid in (".".join(parts), "invalid", "", "a.b.c"):
            with self.subTest(token_kind=len(invalid)), self.assertRaises(InvalidAccessToken):
                decode_access_token(invalid, self.config)

    def test_expired_future_issued_missing_invalid_claims_and_algorithms(self):
        now = int(datetime.now(timezone.utc).timestamp())
        valid = {"sub": str(self.subject), "iat": now - 10, "exp": now + 100}
        invalid = [dict(valid, exp=now - 1), dict(valid, iat=now + 30), dict(valid, sub="not-a-uuid"),
                   dict(valid, sub=123), dict(valid, exp=str(now + 100)), dict(valid, iat=True),
                   dict(valid, exp=now + 100, iat=now + 101)]
        invalid.extend({key: value for key, value in valid.items() if key != missing} for missing in valid)
        key = self.config.jwt_secret_key.get_secret_value()
        for claims in invalid:
            with self.subTest(claim_keys=list(claims)), self.assertRaises(InvalidAccessToken):
                decode_access_token(jwt.encode(claims, key, algorithm="HS256"), self.config)
        for algorithm in ("HS384", "none"):
            token = jwt.encode(valid, secrets.token_urlsafe(48) if algorithm != "none" else "", algorithm=algorithm)
            with self.assertRaises(InvalidAccessToken):
                decode_access_token(token, self.config)

    def test_signing_key_and_expiry_settings_fail_closed_without_secret_exposure(self):
        with patch.dict(os.environ, {}, clear=True):
            missing = Settings(_env_file=None)
            with self.assertRaises(ValidationError) as caught:
                Settings(_env_file=None, jwt_secret_key="short-test-key")
            self.assertNotIn("short-test-key", str(caught.exception))
            for minutes in (0, -1, 1441):
                with self.assertRaises(ValidationError):
                    Settings(_env_file=None, access_token_expire_minutes=minutes)
        with self.assertRaises(AuthenticationUnavailable):
            create_access_token(self.subject, missing)
        with self.assertRaises(AuthenticationUnavailable):
            decode_access_token("anything", missing)
        with patch.dict(os.environ, {"ACCESS_TOKEN_EXPIRE_MINUTES": "10"}, clear=True):
            self.assertEqual(Settings(_env_file=None).access_token_expire_minutes, 10)


class AuthContractTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.config = auth_config()
        self.app = create_app(self.config)
        self.session = MagicMock()
        self.app.dependency_overrides[get_db] = lambda: self.session

        @self.app.get("/test/protected", response_model=UserResponse)
        def protected(user: Annotated[User, Depends(get_current_user)]):
            return user

    def registration(self, **overrides):
        payload = {"business_name": "  Lahore Salon  ", "full_name": "  Salon Owner  ",
                   "email": " Owner@Example.com ", "password": "long test password"}
        payload.update(overrides)
        return payload

    async def test_registration_input_normalization_and_response_allowlist(self):
        payload = self.registration()
        schema = RegisterRequest(**payload)
        self.assertEqual(schema.business_name, "Lahore Salon")
        self.assertEqual(schema.full_name, "Salon Owner")
        self.assertEqual(schema.email, "owner@example.com")
        user = UserResponse(id=uuid4(), business_id=uuid4(), full_name="Salon Owner", email="owner@example.com",
                            role=UserRole.OWNER, is_active=True)
        with patch("app.api.auth.register_owner", return_value=user):
            status, _, body = await post(self.app, "/api/auth/register", payload)
        self.assertEqual(status, 201)
        self.assertEqual(set(json.loads(body)), {"id", "business_id", "full_name", "email", "role", "is_active"})
        self.assertNotIn(payload["password"].encode(), body)
        self.assertNotIn(b"password_hash", body)

    async def test_invalid_inputs_and_public_privilege_fields_are_rejected_without_echo(self):
        invalid = [dict(password="sh0rt!"), dict(password="p" * 129), dict(password=" " * 12),
                   dict(email="invalid"), dict(full_name=" "), dict(business_name=" "), dict(email=123),
                   dict(role="owner"), dict(role="staff"), dict(business_id=str(uuid4())),
                   dict(is_active=True), dict(password_hash="private-input-hash")]
        for change in invalid:
            payload = self.registration(**change)
            with self.subTest(fields=list(change)):
                status, _, body = await post(self.app, "/api/auth/register", payload)
                self.assertEqual(status, 422)
                self.assertNotIn(payload["password"].encode(), body)
                self.assertNotIn(b"private-input-hash", body)
                self.assertTrue(all("input" not in error for error in json.loads(body)["detail"]))
        self.session.add.assert_not_called()

    async def test_missing_signing_key_disables_auth_but_preserves_health(self):
        self.app.state.settings = self.config.model_copy(update={"jwt_secret_key": None})
        for path, payload in [("/api/auth/register", self.registration()),
                              ("/api/auth/login", {"email": "owner@example.com", "password": "password"})]:
            status, _, body = await post(self.app, path, payload)
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body), {"detail": "Authentication is not configured"})
        self.assertEqual((await request(self.app))[0], 200)

    async def test_protected_dependency_rejects_invalid_tokens_and_inactive_or_missing_users(self):
        user_id = uuid4()
        token = create_access_token(user_id, self.config)
        for invalid in (None, "invalid", create_access_token(user_id, auth_config())):
            headers = [("Authorization", "Bearer " + invalid)] if invalid is not None else []
            status, _, _ = await request(self.app, path="/test/protected", extra_headers=headers)
            self.assertEqual(status, 401)
        for user in (None, User(id=user_id, is_active=False)):
            self.session.get.return_value = user
            status, _, _ = await request(self.app, path="/test/protected", extra_headers=[("Authorization", "Bearer " + token)])
            self.assertEqual(status, 401)

    async def test_login_is_documented_as_json_and_password_is_write_only(self):
        status, _, body = await request(self.app, path="/openapi.json")
        self.assertEqual(status, 200)
        schema = json.loads(body)
        content = schema["paths"]["/api/auth/login"]["post"]["requestBody"]["content"]
        self.assertEqual(set(content), {"application/json"})
        self.assertTrue(schema["components"]["schemas"]["RegisterRequest"]["properties"]["password"]["writeOnly"])
        self.assertNotIn("password_hash", schema["components"]["schemas"]["UserResponse"]["properties"])

    async def test_valid_token_loads_current_identity_and_excludes_hash_from_response(self):
        user = User(id=uuid4(), business_id=uuid4(), full_name="Owner", email="owner@example.com",
                    role=UserRole.OWNER, is_active=True, password_hash="private-test-hash")
        self.session.get.return_value = user
        token = create_access_token(user.id, self.config)
        status, _, body = await request(self.app, path="/test/protected", extra_headers=[("Authorization", "Bearer " + token)])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["business_id"], str(user.business_id))
        self.assertNotIn(b"private-test-hash", body)
        self.session.get.assert_called_with(User, user.id)


class PrivateKeySetupTests(unittest.TestCase):
    def test_provision_key_without_changing_other_settings_or_rotating_existing_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            original = b'APP_NAME="Private configuration"\r\nJWT_SECRET_KEY=\r\nDEBUG=false\r\n'
            path.write_bytes(original)
            self.assertTrue(configure(path))
            generated = path.read_bytes()
            self.assertTrue(generated.startswith(b'APP_NAME="Private configuration"\r\nJWT_SECRET_KEY='))
            self.assertTrue(generated.endswith(b'\r\nDEBUG=false\r\n'))
            self.assertFalse(configure(path))
            self.assertEqual(generated, path.read_bytes())
            with patch.dict(os.environ, {}, clear=True):
                self.assertGreaterEqual(len(Settings(_env_file=path).jwt_secret_key.get_secret_value()), 32)

    def test_missing_env_or_invalid_existing_key_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            with self.assertRaises(ValueError):
                configure(path)
            path.write_text("JWT_SECRET_KEY=short-test-key\n", encoding="utf-8")
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                configure(path)
            self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
