from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import dummy_password_hash, hash_password, verify_password
from app.models import Business, User, UserRole
from app.schemas.auth import RegisterRequest, UserResponse


class DuplicateEmail(Exception):
    pass


class InvalidCredentials(Exception):
    pass


def register_owner(session: Session, data: RegisterRequest) -> UserResponse:
    password_hash = hash_password(data.password.get_secret_value())
    try:
        # The unique index is authoritative, including concurrent requests.
        # Business and User commit together; any flush/commit failure rolls back both.
        with session.begin():
            business = Business(name=data.business_name)
            session.add(business)
            session.flush()
            user = User(business_id=business.id, full_name=data.full_name, email=str(data.email),
                        password_hash=password_hash, role=UserRole.OWNER, is_active=True)
            session.add(user)
            session.flush()
            response = UserResponse.model_validate(user)
        return response
    except IntegrityError as error:
        if (getattr(error.orig, "sqlstate", None) == "23505"
                and getattr(getattr(error.orig, "diag", None), "constraint_name", None) == "uq_users_email"):
            raise DuplicateEmail("Email already registered") from None
        raise


def authenticate_user(session: Session, email: str, password: str) -> User:
    user = session.scalar(select(User).where(User.email == email))
    valid = verify_password(password, user.password_hash if user is not None else dummy_password_hash())
    if user is None or not valid or not user.is_active:
        raise InvalidCredentials("Invalid email or password")
    return user
