from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_auth_settings, require_owner_or_staff, unauthorized
from app.core.config import Settings
from app.core.security import create_access_token
from app.db.session import get_db
from app.models import User
from app.schemas.auth import LoginRequest, RegisterRequest, TokenResponse, UserResponse
from app.services.auth import DuplicateEmail, InvalidCredentials, authenticate_user, register_owner


router = APIRouter(prefix="/api/auth", tags=["Authentication"], responses={
    429: {"description": "Authentication rate limit reached", "headers": {
        "Retry-After": {"schema": {"type": "integer"}, "description": "Seconds until retry"}}},
    413: {"description": "Authentication body exceeds the size limit"},
})


@router.get("/me", response_model=UserResponse)
def user_profile(response: Response, user: Annotated[User, Depends(require_owner_or_staff)]) -> User:
    response.headers["Cache-Control"] = "no-store"
    return user


@router.post("/register", response_model=UserResponse, status_code=201)
def register(
    data: RegisterRequest,
    config: Annotated[Settings, Depends(get_auth_settings)],
    session: Annotated[Session, Depends(get_db)],
) -> UserResponse:
    try:
        return register_owner(session, data)
    except DuplicateEmail:
        raise HTTPException(409, "Email already registered") from None


@router.post("/login", response_model=TokenResponse)
def login(
    data: LoginRequest, response: Response,
    config: Annotated[Settings, Depends(get_auth_settings)],
    session: Annotated[Session, Depends(get_db)],
) -> TokenResponse:
    try:
        user = authenticate_user(session, str(data.email), data.password.get_secret_value())
    except InvalidCredentials:
        raise unauthorized() from None
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return TokenResponse(access_token=create_access_token(user.id, config))
