import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from unittest.mock import patch

from pydantic import ValidationError

with patch.dict(os.environ, {}, clear=True):
    from app.core.config import Settings
    from app.main import create_app


async def request(app, method="GET", origin=None, extra_headers=(), path="/health", body=b"", query_string=b""):
    """Exercise the ASGI middleware stack without additional HTTP test packages."""
    headers = [(b"host", b"testserver")]
    if origin:
        headers.append((b"origin", origin.encode()))
    headers.extend((name.lower().encode(), value.encode()) for name, value in extra_headers)
    messages = []

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        messages.append(message)

    await app({
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
        "query_string": query_string, "root_path": "", "headers": headers,
        "client": ("127.0.0.1", 1234), "server": ("testserver", 80),
    }, receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return start["status"], {key.decode(): value.decode() for key, value in start["headers"]}, body


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_defaults_without_database_or_jwt(self):
        settings = Settings(_env_file=None)
        self.assertEqual(settings.app_name, "SalonPulse API")
        self.assertEqual(settings.app_env, "development")
        self.assertFalse(settings.debug)
        self.assertIsNone(settings.database_url)
        self.assertIsNone(settings.jwt_secret_key)
        self.assertEqual(settings.cors_origins, ["http://localhost:5173"])

    def test_environment_overrides(self):
        with patch.dict(os.environ, {"APP_NAME": "Test API", "APP_ENV": "test", "DEBUG": "true", "CORS_ORIGINS": '["http://127.0.0.1:5173"]'}):
            settings = Settings(_env_file=None)
        self.assertEqual(settings.app_name, "Test API")
        self.assertEqual(settings.app_env, "test")
        self.assertTrue(settings.debug)
        self.assertEqual(settings.cors_origins, ["http://127.0.0.1:5173"])
        self.assertEqual(create_app(settings).title, "Test API")

    def test_dotenv_and_environment_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "settings.env"
            file.write_text('APP_NAME="File API"\nDEBUG=true\nDATABASE_URL=\nJWT_SECRET_KEY=\n', encoding="utf-8")
            self.assertEqual(Settings(_env_file=file).app_name, "File API")
            with patch.dict(os.environ, {"APP_NAME": "Environment API"}):
                settings = Settings(_env_file=file)
            self.assertEqual(settings.app_name, "Environment API")
            self.assertIsNone(settings.database_url)
            self.assertIsNone(settings.jwt_secret_key)

    def test_example_loads_without_secrets(self):
        settings = Settings(_env_file=Path(__file__).resolve().parents[1] / ".env.example")
        self.assertIsNone(settings.database_url)
        self.assertIsNone(settings.jwt_secret_key)
        self.assertIn("http://127.0.0.1:5173", settings.cors_origins)

    def test_invalid_origins_fail_closed(self):
        for origin in ["*", "http://*.example.com", "null", "http://localhost:5173/", "http://localhost/path", "https://user:pass@example.com", "http://localhost:99999"]:
            with self.subTest(origin=origin), self.assertRaises(ValidationError):
                Settings(_env_file=None, cors_origins=[origin])

    def test_invalid_boolean_fails(self):
        with self.assertRaises(ValidationError):
            Settings(_env_file=None, debug="not-a-bool")


class CorsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        with patch.dict(os.environ, {}, clear=True):
            self.app = create_app(Settings(_env_file=None, cors_origins=["http://localhost:5173", "http://127.0.0.1:5173"]))

    async def test_health_without_origin(self):
        status, headers, body = await request(self.app)
        self.assertEqual(status, 200)
        self.assertEqual(body, b'{"status":"ok"}')
        self.assertNotIn("access-control-allow-origin", headers)

    async def test_allowed_origins(self):
        for origin in ["http://localhost:5173", "http://127.0.0.1:5173"]:
            with self.subTest(origin=origin):
                status, headers, body = await request(self.app, origin=origin)
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body), {"status": "ok"})
                self.assertEqual(headers["access-control-allow-origin"], origin)
                self.assertIn("Origin", headers["vary"])
                self.assertNotIn("access-control-allow-credentials", headers)

    async def test_disallowed_origins(self):
        for origin in ["https://evil.example", "http://localhost:5174", "http://localhost:5173.evil.example", "null"]:
            with self.subTest(origin=origin):
                _, headers, _ = await request(self.app, origin=origin)
                self.assertNotIn("access-control-allow-origin", headers)

    async def test_allowed_preflight(self):
        status, headers, _ = await request(self.app, method="OPTIONS", origin="http://localhost:5173", extra_headers=[("Access-Control-Request-Method", "POST"), ("Access-Control-Request-Headers", "Content-Type, Authorization, X-Request-ID")])
        self.assertEqual(status, 200)
        self.assertEqual(headers["access-control-allow-origin"], "http://localhost:5173")
        self.assertIn("POST", headers["access-control-allow-methods"])
        self.assertIn("Content-Type", headers["access-control-allow-headers"])

    async def test_rejected_preflight(self):
        status, headers, _ = await request(self.app, method="OPTIONS", origin="https://evil.example", extra_headers=[("Access-Control-Request-Method", "GET")])
        self.assertEqual(status, 400)
        self.assertNotIn("access-control-allow-origin", headers)

    async def test_unapproved_method_and_header(self):
        for header in [("Access-Control-Request-Method", "TRACE"), ("Access-Control-Request-Headers", "X-Unapproved")]:
            extra = [header] if "Method" in header[0] else [("Access-Control-Request-Method", "GET"), header]
            status, _, _ = await request(self.app, method="OPTIONS", origin="http://localhost:5173", extra_headers=extra)
            self.assertEqual(status, 400)

    async def test_docs_available(self):
        status, _, body = await request(self.app, path="/docs")
        self.assertEqual(status, 200)
        self.assertIn(b"swagger", body)


class StartupTests(unittest.TestCase):
    def test_uvicorn_startup_without_database_or_jwt(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        environment = {
            **os.environ,
            "APP_ENV": "test", "DEBUG": "false",
            "DATABASE_URL": "", "JWT_SECRET_KEY": "",
            "CORS_ORIGINS": '["http://localhost:5173"]',
        }
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=Path(__file__).resolve().parents[1], env=environment,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        )
        try:
            for _ in range(100):
                if process.poll() is not None:
                    self.fail(f"Uvicorn exited: {process.stderr.read()}")
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.read(), b'{"status":"ok"}')
                    break
                except (OSError, TimeoutError):
                    time.sleep(0.1)
            else:
                self.fail("Uvicorn did not become ready")
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
