import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

import jwt
from pydantic import ValidationError

from app.core.config import Settings
from app.core.http_security import AuthRateLimiter, SecurityMiddleware
from app.core.security import InvalidAccessToken, create_access_token, decode_access_token
from app.main import create_app
from test_config_cors import request


def config(**overrides):
    with patch.dict(os.environ, {}, clear=True):
        return Settings(_env_file=None, **overrides)


def production_values():
    return dict(app_env='production', debug=False,
                database_url='postgresql+psycopg://application:' + secrets.token_urlsafe(24) + '@db.example.invalid/salon?sslmode=verify-full',
                jwt_secret_key=secrets.token_urlsafe(32), jwt_issuer='https://api.salon.example', jwt_audience='salonpulse-web',
                cors_origins=['https://salon.example'], trusted_hosts=['api.salon.example'])


class ProductionConfigTests(unittest.TestCase):
    def test_secure_defaults_and_development_compatibility(self):
        dev = config()
        self.assertFalse(dev.https_only)
        self.assertTrue(dev.docs_enabled)
        self.assertEqual((dev.login_rate_limit, dev.registration_rate_limit), (120, 60))
        prod = config(**production_values())
        self.assertTrue(prod.https_only)
        self.assertFalse(prod.docs_enabled)
        self.assertEqual((prod.login_rate_limit, prod.registration_rate_limit), (10, 5))

    def test_insecure_production_configuration_is_rejected_without_values(self):
        valid = production_values()
        for values in ({'debug': True}, {'https_only': False}, {'database_url': None},
                       {'database_url': valid['database_url'].replace('verify-full', 'prefer')},
                       {'jwt_secret_key': 'a' * 64}, {'jwt_secret_key': None}, {'jwt_issuer': None},
                       {'jwt_audience': None}, {'access_token_expire_minutes': 1440},
                       {'cors_origins': ['http://salon.example']}, {'cors_origins': []},
                       {'cors_origins': ['https://localhost']}, {'trusted_hosts': ['localhost']},
                       {'cors_origins': ['https://app.localhost']}, {'trusted_hosts': ['0.0.0.0']},
                       {'login_rate_limit': 0}, {'registration_rate_limit': 0}):
            with self.subTest(fields=list(values)), self.assertRaises(ValidationError) as caught:
                config(**{**valid, **values})
            self.assertNotIn(valid['jwt_secret_key'], str(caught.exception))
            self.assertNotIn(valid['database_url'], str(caught.exception))

    def test_hosts_and_proxy_trust_require_explicit_values(self):
        for hosts in ([], ['*'], ['*.example.com'], ['https://api.example.com'], ['api.example.com:8000'], ['bad host'], ['[::1']):
            with self.assertRaises(ValidationError):
                config(trusted_hosts=hosts)
        for proxies in (['*'], ['0.0.0.0/0'], ['::/0'], ['proxy.example.com'], ['bad']):
            with self.assertRaises(ValidationError):
                config(trusted_proxies=proxies)
        self.assertEqual(config(trusted_proxies=['192.0.2.8']).trusted_proxies, ['192.0.2.8/32'])

    def test_staging_uses_production_policy_and_model_copy_cannot_bypass_app_validation(self):
        secure = config(**{**production_values(), 'app_env': 'staging'})
        self.assertTrue(secure.https_only)
        with self.assertRaises(ValidationError):
            create_app(secure.model_copy(update={'debug': True}))

    def test_production_jwt_requires_correct_issuer_audience_and_lifetime(self):
        settings = config(**production_values())
        subject = uuid4()
        token = create_access_token(subject, settings)
        self.assertEqual(decode_access_token(token, settings), subject)
        claims = jwt.decode(token, settings.jwt_secret_key.get_secret_value(), algorithms=['HS256'], audience=settings.jwt_audience, issuer=settings.jwt_issuer)
        for changes in ({'iss': 'other'}, {'aud': 'other'}, {'exp': claims['iat'] + 7200}):
            altered = jwt.encode({**claims, **changes}, settings.jwt_secret_key.get_secret_value(), algorithm='HS256')
            with self.assertRaises(InvalidAccessToken):
                decode_access_token(altered, settings)
        with self.assertRaises(InvalidAccessToken):
            decode_access_token('x' * 8193, settings)


class LimiterTests(unittest.TestCase):
    def test_limits_expiry_separate_actions_and_bounded_capacity(self):
        clock = [0.0]
        limiter = AuthRateLimiter(2, lambda: clock[0])
        self.assertEqual(limiter.consume(('login', 'one'), 1, 60), 0)
        self.assertEqual(limiter.consume(('login', 'one'), 1, 60), 60)
        self.assertEqual(limiter.consume(('register', 'one'), 1, 60), 0)
        self.assertEqual(limiter.consume(('login', 'two'), 1, 60), 60)
        self.assertEqual(len(limiter.buckets), 2)
        clock[0] = 60
        self.assertEqual(limiter.consume(('login', 'two'), 1, 60), 0)
        self.assertEqual(len(limiter.buckets), 1)

    def test_concurrent_requests_cannot_exceed_the_limit(self):
        limiter = AuthRateLimiter(10)
        with ThreadPoolExecutor(max_workers=16) as workers:
            results = list(workers.map(lambda _: limiter.consume(('login', 'peer'), 3, 60), range(32)))
        self.assertEqual(results.count(0), 3)
        self.assertTrue(all(result >= 1 for result in results if result))


class HTTPSecurityTests(unittest.IsolatedAsyncioTestCase):
    def app(self, **values):
        app = create_app(config(**values))
        self.addCleanup(app.state.database.dispose)
        return app

    async def auth(self, app, path='/api/auth/login', **values):
        return await request(app, method='POST', path=path, body=b'{}',
                             extra_headers=values.pop('extra_headers', [('Content-Type', 'application/json')]), **values)

    async def test_login_and_registration_rate_limits_include_bad_requests_and_cors(self):
        app = self.app(login_rate_limit=2, registration_rate_limit=1)
        for _ in range(2):
            self.assertEqual((await self.auth(app))[0], 503)  # No configured secret, still throttled.
        status, headers, body = await self.auth(app, origin='http://localhost:5173')
        self.assertEqual(status, 429)
        self.assertGreaterEqual(int(headers['retry-after']), 1)
        self.assertEqual(headers['access-control-allow-origin'], 'http://localhost:5173')
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertNotIn('password', body.decode())
        self.assertEqual((await self.auth(app, '/api/auth/register'))[0], 503)
        self.assertEqual((await self.auth(app, '/api/auth/register'))[0], 429)
        self.assertEqual((await request(app, method='OPTIONS', path='/api/auth/login', origin='http://localhost:5173',
            extra_headers=[('Access-Control-Request-Method', 'POST')]))[0], 200)

    async def test_untrusted_forwarding_headers_cannot_bypass_limits_or_https(self):
        app = self.app(login_rate_limit=1)
        for i in range(2):
            result = await self.auth(app, extra_headers=[('X-Forwarded-For', '198.51.100.' + str(i + 1)), ('X-Real-IP', '203.0.113.3')])
            self.assertEqual(result[0], 503 if i == 0 else 429)
        prod = self.app(**production_values())
        self.assertEqual((await request(prod, host='api.salon.example', extra_headers=[('X-Forwarded-Proto', 'https')]))[0], 400)

    async def test_trusted_proxy_chain_uses_last_untrusted_address_not_spoofed_prefix(self):
        app = self.app(login_rate_limit=1, trusted_proxies=['127.0.0.1/32', '192.0.2.0/24'])
        for i in range(2):
            headers = [('X-Forwarded-For', f'203.0.113.{i + 1}, 198.51.100.8, 192.0.2.2')]
            self.assertEqual((await self.auth(app, extra_headers=headers))[0], 503 if i == 0 else 429)
        self.assertEqual((await self.auth(app, extra_headers=[('X-Forwarded-For', '198.51.100.9')]))[0], 503)
        for headers in ([('X-Forwarded-For', 'not-an-ip')], [('X-Forwarded-Proto', 'https,http')],
                        [('X-Forwarded-For', 'fe80::1%spoof')],
                        [('X-Forwarded-For', '198.51.100.3'), ('X-Forwarded-For', '198.51.100.4')]):
            self.assertEqual((await self.auth(app, extra_headers=headers))[0], 400)

    async def test_ipv6_addresses_and_mapped_ipv4_cannot_rotate_rate_buckets(self):
        app = self.app(login_rate_limit=1)
        self.assertEqual((await self.auth(app, client=('::ffff:198.51.100.8', 8001)))[0], 503)
        self.assertEqual((await self.auth(app, client=('198.51.100.8', 8002)))[0], 429)
        self.assertEqual((await request(app, host='[::1]:8000'))[0], 200)

    async def test_hosts_https_headers_and_production_docs(self):
        app = self.app(**production_values(), trusted_proxies=['127.0.0.1'])
        self.assertEqual((await request(app, host='api.salon.example', scheme='http'))[0], 400)
        status, headers, _ = await request(app, host='api.salon.example', extra_headers=[('X-Forwarded-Proto', 'https')])
        self.assertEqual(status, 200)
        self.assertEqual(headers['strict-transport-security'], 'max-age=31536000')
        self.assertEqual(headers['x-content-type-options'], 'nosniff')
        self.assertEqual(headers['x-frame-options'], 'DENY')
        self.assertEqual(headers['referrer-policy'], 'no-referrer')
        self.assertIn("default-src 'none'", headers['content-security-policy'])
        self.assertEqual((await request(app, host='evil.example', scheme='https'))[0], 400)
        self.assertEqual((await request(app, host='api.salon.example', scheme='https', extra_headers=[('Host', 'evil.example')]))[0], 400)
        for path in ('/docs', '/redoc', '/openapi.json'):
            self.assertEqual((await request(app, path=path, host='api.salon.example', scheme='https'))[0], 404)
        dev = self.app()
        self.assertEqual((await request(dev, path='/docs'))[0], 200)
        self.assertNotIn('strict-transport-security', (await request(dev))[1])

    async def test_auth_body_size_is_limited_before_validation(self):
        app = self.app(auth_max_body_bytes=1024)
        status, headers, _ = await request(app, method='POST', path='/api/auth/register', body=b'x' * 1025)
        self.assertEqual(status, 413)
        self.assertEqual(headers['cache-control'], 'no-store')

    async def test_unhandled_errors_never_expose_secrets_in_response_or_logs(self):
        app = self.app(debug=True)
        secret = secrets.token_urlsafe(32)
        @app.get('/crash')
        def crash():
            raise RuntimeError('private-' + secret)
        with self.assertLogs('salonpulse.security', level='ERROR') as logs:
            status, headers, body = await request(app, path='/crash', origin='http://localhost:5173')
        self.assertEqual(status, 500)
        self.assertEqual(json.loads(body), {'detail': 'Internal server error'})
        self.assertNotIn(secret, body.decode() + str(logs.output))
        self.assertEqual(headers['access-control-allow-origin'], 'http://localhost:5173')
        self.assertEqual(headers['cache-control'], 'no-store')

    async def test_disconnected_error_response_does_not_rethrow_private_exception(self):
        secret = secrets.token_urlsafe(32)
        async def crash(scope, receive, send):
            raise RuntimeError('private-' + secret)
        async def receive():
            return {'type': 'http.disconnect'}
        async def send(message):
            raise ConnectionError('Client disconnected')
        middleware = SecurityMiddleware(crash, config())
        with self.assertLogs('salonpulse.security', level='ERROR') as logs:
            await middleware({'type': 'http', 'method': 'GET', 'path': '/crash', 'scheme': 'http',
                              'headers': [(b'host', b'testserver')], 'client': ('127.0.0.1', 8765)}, receive, send)
        self.assertEqual(len(logs.output), 2)
        self.assertNotIn(secret, str(logs.output))


class SecureLauncherTests(unittest.TestCase):
    def test_real_http_proxy_spoofing_rate_limit_and_log_redaction(self):
        backend = Path(__file__).resolve().parents[1]
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        marker = secrets.token_urlsafe(24)
        env = {**os.environ, 'DEBUG': 'false', 'APP_ENV': 'development', 'LOGIN_RATE_LIMIT': '1',
               'LOGIN_RATE_WINDOW_SECONDS': '60', 'TRUSTED_PROXIES': '[]', 'TRUSTED_HOSTS': '["127.0.0.1"]',
               'PYTHONDONTWRITEBYTECODE': '1'}
        process = subprocess.Popen([sys.executable, '-B', '-m', 'app.serve', '--port', str(port)],
            cwd=backend, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            origin = f'http://127.0.0.1:{port}'
            for _ in range(100):
                try:
                    with urlopen(origin + '/health', timeout=1) as response:
                        self.assertEqual(response.status, 200)
                    break
                except URLError:
                    time.sleep(0.1)
            else:
                self.fail('Secure launcher startup timed out')
            statuses = []
            for peer in ('198.51.100.1', '198.51.100.2'):
                message = Request(origin + '/api/auth/login?private=' + marker, method='POST', data=b'{}',
                                  headers={'Content-Type': 'application/json', 'X-Forwarded-For': peer})
                try:
                    with urlopen(message, timeout=5) as response:
                        statuses.append(response.status)
                except HTTPError as error:
                    statuses.append(error.code)
                    self.assertNotIn('server', {key.lower() for key in error.headers})
            self.assertIn(statuses[0], (422, 503))
            self.assertEqual(statuses[1], 429)
        finally:
            process.terminate()
            output, errors = process.communicate(timeout=10)
        self.assertNotIn(marker, (output + errors).decode())

    def test_invalid_production_configuration_fails_without_traceback_or_values(self):
        secret = secrets.token_urlsafe(24)
        result = subprocess.run([sys.executable, '-B', '-m', 'app.serve'],
            cwd=Path(__file__).resolve().parents[1], capture_output=True, timeout=15,
            env={**os.environ, 'APP_ENV': 'production', 'DEBUG': 'true', 'JWT_SECRET_KEY': secret,
                 'DATABASE_URL': 'invalid-' + secret, 'PYTHONDONTWRITEBYTECODE': '1'})
        self.assertEqual(result.returncode, 78)
        self.assertNotIn(secret, (result.stdout + result.stderr).decode())
        self.assertNotIn('Traceback', result.stderr.decode())
