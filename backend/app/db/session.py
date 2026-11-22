from collections.abc import Iterator
from threading import Lock

from fastapi import HTTPException, Request, status
from pydantic import SecretStr
from sqlalchemy import Engine, create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker


class DatabaseUnavailable(Exception):
    """A deliberately credential-free database configuration error."""


class Database:
    """One lazy engine/pool per application process; no connection at import time."""

    def __init__(self, url: SecretStr | None):
        self._url = url
        self._engine: Engine | None = None
        self._sessions: sessionmaker[Session] | None = None
        self._lock = Lock()

    def session_factory(self) -> sessionmaker[Session]:
        with self._lock:
            if self._sessions is None:
                if self._url is None:
                    raise DatabaseUnavailable("Database unavailable")
                try:
                    url = make_url(self._url.get_secret_value())
                    if url.drivername != "postgresql+psycopg":
                        raise DatabaseUnavailable("Database unavailable")
                    engine = create_engine(
                        url,
                        pool_pre_ping=True,
                        pool_size=5,
                        max_overflow=5,
                        pool_timeout=5,
                        pool_recycle=1800,
                        echo=False,
                        hide_parameters=True,
                        connect_args={"connect_timeout": 5, "options": "-c statement_timeout=5000"},
                    )
                    self._engine = engine
                    self._sessions = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
                except (SQLAlchemyError, ValueError, ImportError):
                    raise DatabaseUnavailable("Database unavailable") from None
            return self._sessions

    def dispose(self) -> None:
        with self._lock:
            if self._engine is not None:
                self._engine.dispose()
                self._engine = None
                self._sessions = None


def get_db(request: Request) -> Iterator[Session]:
    """Request-scoped session; callers must explicitly commit future writes.

    Session context management closes and rolls back uncommitted transactions
    on every exit, including exceptions, before returning connections to the pool.
    """
    try:
        with request.app.state.database.session_factory()() as session:
            yield session
    except (DatabaseUnavailable, SQLAlchemyError):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Database unavailable") from None
