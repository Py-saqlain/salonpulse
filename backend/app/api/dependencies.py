from typing import Annotated

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.security import AuthenticationUnavailable, InvalidAccessToken, decode_access_token, signing_key
from app.db.session import get_db
from app.db.tenant import TenantScope
from app.models import Business, User, UserRole


bearer = HTTPBearer(auto_error=False)


def get_auth_settings(request: Request) -> Settings:
    config = request.app.state.settings
    try:
        signing_key(config)
    except AuthenticationUnavailable:
        raise HTTPException(503, "Authentication is not configured") from None
    return config


def unauthorized() -> HTTPException:
    return HTTPException(401, "Invalid email or password", headers={"WWW-Authenticate": "Bearer"})


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    config: Annotated[Settings, Depends(get_auth_settings)],
    session: Annotated[Session, Depends(get_db)],
) -> User:
    if credentials is None:
        raise unauthorized()
    try:
        subject = decode_access_token(credentials.credentials, config)
    except InvalidAccessToken:
        raise unauthorized() from None
    # Trust live account state, never client-provided roles or tenant claims.
    user = session.get(User, subject)
    if user is None or not user.is_active:
        raise unauthorized()
    return user


def require_owner(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != UserRole.OWNER:
        raise HTTPException(403, "Insufficient permissions", headers={"WWW-Authenticate": 'Bearer error="insufficient_scope"'})
    return user


def require_owner_or_staff(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role not in {UserRole.OWNER, UserRole.STAFF}:
        raise HTTPException(403, "Insufficient permissions", headers={"WWW-Authenticate": 'Bearer error="insufficient_scope"'})
    return user


def get_current_business(
    user: Annotated[User, Depends(require_owner_or_staff)],
    session: Annotated[Session, Depends(get_db)],
) -> Business:
    # This is the tenant root, resolved exclusively from the live user record.
    business = session.scalar(select(Business).where(Business.id == user.business_id))
    if business is None:
        raise HTTPException(404, "Business not found")
    return business


def get_tenant_scope(user: Annotated[User, Depends(require_owner_or_staff)]) -> TenantScope:
    return TenantScope(business_id=user.business_id)
