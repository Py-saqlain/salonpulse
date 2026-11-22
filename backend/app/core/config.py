from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[2] / ".env",
        env_file_encoding="utf-8",
        env_ignore_empty=True,
        extra="ignore",
    )

    app_name: str = Field(default="SalonPulse API", min_length=1)
    app_env: Literal["development", "test", "staging", "production"] = "development"
    debug: bool = False
    # SQLAlchemy URL: postgresql+psycopg://...; optional for liveness/docs startup.
    database_url: SecretStr | None = None
    jwt_secret_key: SecretStr | None = None
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])

    @field_validator("cors_origins")
    @classmethod
    def explicit_origins(cls, origins: list[str]) -> list[str]:
        for origin in origins:
            parsed = urlsplit(origin)
            # Origins contain a scheme, hostname and optional port, never paths.
            if (
                origin != origin.strip()
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
            _ = parsed.port  # Reject invalid port numbers.
        return list(dict.fromkeys(origins))


settings = Settings()
