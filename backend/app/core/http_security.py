"""Transport-aware security and bounded, per-process authentication throttling."""

from collections.abc import Callable
import heapq
from ipaddress import IPv6Address, ip_address, ip_network
import logging
from math import ceil
from threading import Lock
import time

from starlette.datastructures import MutableHeaders
from starlette.responses import JSONResponse


logger = logging.getLogger("salonpulse.security")


class AuthRateLimiter:
    """Fixed windows, no eviction of live buckets, no credentials in keys/logs."""

    def __init__(self, capacity: int, clock: Callable[[], float] = time.monotonic):
        self.capacity, self.clock = capacity, clock
        self.buckets = {}
        self.expiry = []
        self.lock = Lock()

    def consume(self, key: tuple[str, str], limit: int, window: int) -> int:
        with self.lock:
            now = self.clock()
            while self.expiry and self.expiry[0][0] <= now:
                expiry, expired = heapq.heappop(self.expiry)
                if self.buckets.get(expired, (None,))[0] == expiry:
                    del self.buckets[expired]
            bucket = self.buckets.get(key)
            if bucket is None:
                if len(self.buckets) >= self.capacity:
                    return max(1, ceil(self.expiry[0][0] - now))
                bucket = (now + window, 0)
                heapq.heappush(self.expiry, (bucket[0], key))
            expiry, used = bucket
            if used >= limit:
                return max(1, ceil(expiry - now))
            self.buckets[key] = (expiry, used + 1)
            return 0


def canonical_ip(value):
    if "%" in value:
        raise ValueError("Scoped addresses are not forwarded client identities")
    address = ip_address(value)
    return address.ipv4_mapped if isinstance(address, IPv6Address) and address.ipv4_mapped else address


class SecurityMiddleware:
    def __init__(self, app, config):
        self.app, self.config = app, config
        self.proxies = [ip_network(value) for value in config.trusted_proxies]
        self.limiter = AuthRateLimiter(config.rate_limit_max_clients)

    def trusted(self, address):
        return any(address in network for network in self.proxies)

    def transport(self, scope, headers):
        try:
            peer = canonical_ip(scope["client"][0])
        except (ValueError, TypeError, KeyError):
            return "unknown", scope.get("scheme", "http")
        client, scheme = peer, scope.get("scheme", "http")
        if self.trusted(peer):
            forwarded = headers.get(b"x-forwarded-for", [])
            proto = headers.get(b"x-forwarded-proto", [])
            if len(forwarded) > 1 or len(proto) > 1:
                raise ValueError("Duplicate proxy headers")
            if forwarded:
                parts = forwarded[0].decode("ascii").split(",")
                if not 1 <= len(parts) <= 16:
                    raise ValueError("Invalid proxy chain")
                chain = [canonical_ip(value.strip()) for value in parts]
                for address in reversed(chain):
                    if not self.trusted(client):
                        break
                    client = address
            if proto:
                scheme = proto[0].decode("ascii").strip().lower()
                if scheme not in {"http", "https"}:
                    raise ValueError("Invalid forwarded scheme")
        return str(client), scheme

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {}
        for key, value in scope.get("headers", []):
            headers.setdefault(key.lower(), []).append(value)
        origin = headers.get(b"origin", [b""])[0].decode("latin-1")
        secure = scope.get("scheme") == "https"
        started = finished = False

        async def safe_send(message):
            nonlocal started, finished
            if message["type"] == "http.response.start":
                started = True
                message = {**message, "headers": list(message.get("headers", []))}
                output = MutableHeaders(scope=message)
                for name in ("server", "x-powered-by"):
                    if name in output:
                        del output[name]
                output["X-Content-Type-Options"] = "nosniff"
                output["X-Frame-Options"] = "DENY"
                output["Referrer-Policy"] = "no-referrer"
                output["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
                output["Cache-Control"] = "no-store"
                output["Pragma"] = "no-cache"
                policy = "frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
                if scope.get("path") not in {"/docs", "/redoc", "/docs/oauth2-redirect"}:
                    policy += "; default-src 'none'; form-action 'none'"
                output["Content-Security-Policy"] = policy
                if secure and self.config.production:
                    output["Strict-Transport-Security"] = "max-age=31536000"
                if origin in self.config.cors_origins:
                    output["Access-Control-Allow-Origin"] = origin
                    output["Access-Control-Expose-Headers"] = "Retry-After"
                    if "origin" not in output.get("Vary", "").lower().split(", "):
                        output.add_vary_header("Origin")
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                finished = True
            await send(message)

        async def reject(code, detail, extra=None):
            await JSONResponse({"detail": detail}, status_code=code, headers=extra)(scope, receive, safe_send)

        try:
            if len(headers.get(b"host", [])) != 1:
                return await reject(400, "Invalid host header")
            try:
                client, scheme = self.transport(scope, headers)
            except (ValueError, UnicodeError):
                return await reject(400, "Invalid proxy headers")
            secure = scheme == "https"
            if self.config.https_only and not secure:
                return await reject(400, "HTTPS is required")
            scope = {**scope, "scheme": scheme, "client": (client, 0), "headers": [
                (key, value) for key, value in scope.get("headers", [])
                if key.lower() not in {b"forwarded", b"x-forwarded-for", b"x-forwarded-proto", b"x-forwarded-host", b"x-real-ip"}
            ]}
            path = scope.get("path", "").rstrip("/")
            if scope.get("method") == "POST" and path in {"/api/auth/login", "/api/auth/register"}:
                login = path.endswith("/login")
                retry = self.limiter.consume((path, client),
                    self.config.login_rate_limit if login else self.config.registration_rate_limit,
                    self.config.login_rate_window_seconds if login else self.config.registration_rate_window_seconds)
                if retry:
                    return await reject(429, "Too many authentication attempts. Try again later.", {"Retry-After": str(retry)})
                body = bytearray()
                while True:
                    part = await receive()
                    if part["type"] == "http.disconnect":
                        return
                    body.extend(part.get("body", b""))
                    if len(body) > self.config.auth_max_body_bytes:
                        return await reject(413, "Authentication request is too large")
                    if not part.get("more_body", False):
                        break
                original_receive = receive
                delivered = False

                async def auth_receive():
                    nonlocal delivered
                    if not delivered:
                        delivered = True
                        return {"type": "http.request", "body": bytes(body), "more_body": False}
                    return await original_receive()
                receive = auth_receive
            await self.app(scope, receive, safe_send)
        except Exception:
            # Intentionally omit exception text, URL/query, headers and body.
            # SQL, tokens, validation inputs and passwords can occur in them.
            logger.error("Unhandled application error; private details suppressed")
            try:
                if not started:
                    await reject(500, "Internal server error")
                elif not finished:
                    await safe_send({"type": "http.response.body", "body": b"", "more_body": False})
            except Exception:
                # A disconnected client must not cause the original private
                # exception to escape as a chained server-log traceback.
                logger.error("Error response delivery failed; private details suppressed")
