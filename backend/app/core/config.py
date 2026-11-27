from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from ipaddress import ip_address, ip_network
import re

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def local_host(host):
    if host in {"localhost", "testserver"} or host.endswith(".localhost"):
        return True
    try:
        address = ip_address(host.strip("[]"))
        return address.is_loopback or address.is_unspecified
    except ValueError:
        return False


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[2] / ".env",
        env_file_encoding="utf-8",
        env_ignore_empty=True,
        extra="ignore",
        hide_input_in_errors=True,
    )

    app_name: str = Field(default="SalonPulse API", min_length=1)
    app_env: Literal["development", "test", "staging", "production"] = "development"
    debug: bool = False
    # SQLAlchemy URL: postgresql+psycopg://...; optional for liveness/docs startup.
    database_url: SecretStr | None = None
    jwt_secret_key: SecretStr | None = None
    access_token_expire_minutes: int = Field(default=30, ge=1, le=1440)
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
    trusted_hosts: list[str] = Field(default_factory=lambda: ["localhost", "127.0.0.1", "[::1]", "testserver"])
    trusted_proxies: list[str] = Field(default_factory=list)
    https_only: bool | None = None
    docs_enabled: bool | None = None
    jwt_issuer: str | None = Field(default=None, min_length=1, max_length=200)
    jwt_audience: str | None = Field(default=None, min_length=1, max_length=200)
    login_rate_limit: int | None = Field(default=None, ge=1, le=1000)
    registration_rate_limit: int | None = Field(default=None, ge=1, le=1000)
    login_rate_window_seconds: int = Field(default=60, ge=1, le=3600)
    registration_rate_window_seconds: int = Field(default=3600, ge=1, le=86400)
    rate_limit_max_clients: int = Field(default=10000, ge=1, le=100000)
    auth_max_body_bytes: int = Field(default=16384, ge=1024, le=65536)

    @property
    def production(self) -> bool:
        return self.app_env in {"staging", "production"}

    @field_validator("trusted_hosts")
    @classmethod
    def explicit_hosts(cls, hosts):
        if not hosts:
            raise ValueError("TRUSTED_HOSTS must contain explicit hostnames")
        for host in hosts:
            if host != host.strip().lower() or not host or "*" in host:
                raise ValueError("TRUSTED_HOSTS must contain lowercase exact hosts, without wildcards")
            if host.startswith("[") != host.endswith("]"):
                raise ValueError("TRUSTED_HOSTS contains an invalid IP literal")
            try:
                address = ip_address(host.strip("[]"))
                if "%" in host or (host.startswith("[") and address.version != 6):
                    raise ValueError
            except ValueError:
                if len(host) > 253 or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part) for part in host.split(".")):
                    raise ValueError("TRUSTED_HOSTS must contain hosts without schemes, paths or ports")
        return list(dict.fromkeys(hosts))

    @field_validator("trusted_proxies")
    @classmethod
    def explicit_proxies(cls, proxies):
        try:
            if any("%" in value for value in proxies):
                raise ValueError
            networks = [ip_network(value, strict=False) for value in proxies]
        except ValueError:
            raise ValueError("TRUSTED_PROXIES must contain IP addresses or CIDRs") from None
        if any(network.prefixlen == 0 for network in networks):
            raise ValueError("TRUSTED_PROXIES must never trust all addresses")
        return [str(network) for network in networks]

    @model_validator(mode="after")
    def environment_security(self):
        if self.https_only is None:
            self.https_only = self.production
        if self.docs_enabled is None:
            self.docs_enabled = not self.production
        if self.login_rate_limit is None:
            self.login_rate_limit = 10 if self.production else 120
        if self.registration_rate_limit is None:
            self.registration_rate_limit = 5 if self.production else 60
        if not self.production:
            return self
        if self.debug or not self.https_only:
            raise ValueError("Production requires DEBUG=false and HTTPS_ONLY=true")
        if not self.cors_origins or any(urlsplit(origin).scheme != "https" or
                local_host(urlsplit(origin).hostname) for origin in self.cors_origins):
            raise ValueError("Production requires explicit HTTPS frontend CORS origins")
        if any(local_host(host) for host in self.trusted_hosts):
            raise ValueError("Production requires explicit deployment TRUSTED_HOSTS")
        if (not self.jwt_issuer or not self.jwt_audience or self.jwt_issuer != self.jwt_issuer.strip()
                or self.jwt_audience != self.jwt_audience.strip()
                or any(ord(char) < 32 for char in self.jwt_issuer + self.jwt_audience)):
            raise ValueError("Production requires JWT_ISSUER and JWT_AUDIENCE")
        if self.access_token_expire_minutes > 60:
            raise ValueError("Production access tokens must expire within 60 minutes")
        key = self.jwt_secret_key.get_secret_value() if self.jwt_secret_key else ""
        if (len(key.encode()) < 32 or len(set(key)) < 16 or key != key.strip()
                or any(marker in key.lower() for marker in ("replace", "changeme", "placeholder", "example", "development"))):
            raise ValueError("Production requires a strong independently generated JWT secret")
        try:
            from sqlalchemy.engine import make_url
            url = make_url(self.database_url.get_secret_value() if self.database_url else "")
            if (url.drivername != "postgresql+psycopg" or not url.host or not url.database or not url.username
                    or url.username.lower() in {"postgres", "root"}
                    or len(url.password or "") < 16 or len(set(url.password or "")) < 8 or url.password == key
                    or any(marker in (url.password or "").lower() for marker in ("replace", "changeme", "placeholder", "example"))
                    or url.query.get("sslmode") != "verify-full"):
                raise ValueError
        except Exception:
            raise ValueError("Production requires PostgreSQL credentials and sslmode=verify-full") from None
        return self

    @field_validator("jwt_secret_key")
    @classmethod
    def strong_signing_key(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value().encode("utf-8")) < 32:
            raise ValueError("JWT_SECRET_KEY must contain at least 32 bytes of securely generated key material")
        return value

    @field_validator("cors_origins")
    @classmethod
    def explicit_origins(cls, origins: list[str]) -> list[str]:
        for origin in origins:
            parsed = urlsplit(origin)
            # Origins contain a scheme, hostname and optional port, never paths.
            if (
                origin != origin.strip()
                or any(ord(char) <= 32 or ord(char) == 127 for char in origin)
                or "*" in origin
                or parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or parsed.path
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError("CORS_ORIGINS must contain explicit HTTP(S) origins without paths or wildcards")
            cls.explicit_hosts([parsed.hostname])
            _ = parsed.port  # Reject invalid port numbers.
        return list(dict.fromkeys(origins))


settings = Settings()
