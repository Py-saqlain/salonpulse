from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings, settings
from app.db.session import Database, get_db


def create_app(config: Settings) -> FastAPI:
    database = Database(config.database_url)

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        try:
            yield
        finally:
            database.dispose()

    application = FastAPI(title=config.app_name, debug=config.debug, lifespan=lifespan)
    application.state.database = database
    application.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    )

    @application.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/health/db")
    def database_health(session: Annotated[Session, Depends(get_db)]) -> dict[str, str]:
        try:
            if session.execute(text("SELECT 1")).scalar_one() != 1:
                raise HTTPException(503, "Database unavailable")
        except SQLAlchemyError:
            raise HTTPException(503, "Database unavailable") from None
        return {"status": "ok"}

    return application


app = create_app(settings)
