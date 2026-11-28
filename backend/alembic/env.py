"""Use application settings without storing a URL in Alembic's INI/logging."""

from logging.config import fileConfig

from alembic import context
from alembic.util import CommandError
from sqlalchemy import create_engine, pool
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError

from app.db.base import Base
import app.models  # noqa: F401 -- register all ORM tables before autogeneration

config = context.config
if config.config_file_name is not None and not config.attributes.get("skip_logging_configuration", False):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata
comparison_options = {
    "target_metadata": target_metadata,
    "compare_type": True,
    "compare_server_default": True,
    # Named checks are compared by name, not by expression text.
    "autogenerate_plugins": ["alembic.autogenerate.*", "alembic.ext.checkconstraint_byname"],
}


def database_url():
    # Supplied migration connections do not need runtime JWT/application secrets.
    from app.core.config import settings
    if settings.database_url is None:
        raise CommandError("Configure DATABASE_URL privately in backend/.env.")
    try:
        url = make_url(settings.database_url.get_secret_value())
        if url.drivername != "postgresql+psycopg":
            raise ValueError
        return url
    except (ValueError, SQLAlchemyError):
        raise CommandError("DATABASE_URL must be a valid postgresql+psycopg URL.") from None


def read_only_command():
    options = config.cmd_opts
    command = getattr(options, "cmd", (None,))[0]
    return (
        bool(getattr(options, "autogenerate", False))
        or getattr(command, "__name__", None) in {"check", "current"}
        or config.attributes.get("read_only", False)
    )


def run_migrations_offline():
    context.configure(url=database_url(), literal_binds=True,
                      dialect_opts={"paramstyle": "named"}, **comparison_options)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online():
    supplied = config.attributes.get('connection')
    if supplied is not None:
        read_only = read_only_command()
        if read_only:
            supplied.exec_driver_sql("SET TRANSACTION READ ONLY")
        context.configure(connection=supplied, dont_mutate=read_only, **comparison_options)
        with context.begin_transaction():
            context.run_migrations()
        return
    engine = create_engine(
        database_url(), poolclass=pool.NullPool, echo=False, hide_parameters=True,
        connect_args={"connect_timeout": 5},
    )
    try:
        with engine.connect() as connection, connection.begin():
            read_only = read_only_command()
            if read_only:
                # PostgreSQL rejects writes. dont_mutate prevents Alembic
                # from trying to create its version table on an empty database.
                connection.exec_driver_sql("SET TRANSACTION READ ONLY")
            context.configure(connection=connection, dont_mutate=read_only, **comparison_options)
            with context.begin_transaction():
                context.run_migrations()
    except SQLAlchemyError:
        raise CommandError("Database operation failed; check local configuration and connectivity privately.") from None
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
