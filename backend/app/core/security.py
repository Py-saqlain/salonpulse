"""Password/JWT primitives. Never log passwords, hashes, keys, or tokens."""

from datetime import datetime, timedelta, timezone
from functools import lru_cache
import secrets
from uuid import UUID

import jwt
from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError, HashVerificationError

from app.core.config import Settings


password_hasher = PasswordHash.recommended()  # Argon2id, library-recommended parameters
JWT_ALGORITHM = "HS256"


class AuthenticationUnavailable(Exception):
    pass


class InvalidAccessToken(Exception):
    pass


def signing_key(config: Settings) -> str:
    if config.jwt_secret_key is None:
        raise AuthenticationUnavailable("Authentication is not configured")
    key = config.jwt_secret_key.get_secret_value()
    if len(key.encode("utf-8")) < 32:
        raise AuthenticationUnavailable("Authentication is not configured")
    return key


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        return password_hasher.verify(password, stored_hash)
    except (UnknownHashError, HashVerificationError, ValueError):
        return False


@lru_cache(maxsize=1)
def dummy_password_hash() -> str:
    """Spend comparable verification work when a login identity is absent."""
    return hash_password(secrets.token_urlsafe(32))


def create_access_token(user_id: UUID, config: Settings) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode({"sub": str(user_id), "iat": now,
                       "exp": now + timedelta(minutes=config.access_token_expire_minutes)},
                      signing_key(config), algorithm=JWT_ALGORITHM)


def decode_access_token(token: str, config: Settings) -> UUID:
    key = signing_key(config)
    try:
        claims = jwt.decode(token, key, algorithms=[JWT_ALGORITHM],
                            options={"require": ["sub", "iat", "exp"]})
        if (type(claims["iat"]) is not int or type(claims["exp"]) is not int
                or claims["exp"] <= claims["iat"]):
            raise ValueError
        subject = UUID(claims["sub"])
        if str(subject) != claims["sub"]:
            raise ValueError
        return subject
    except (jwt.InvalidTokenError, ValueError, TypeError, AttributeError):
        raise InvalidAccessToken("Invalid access token") from None
