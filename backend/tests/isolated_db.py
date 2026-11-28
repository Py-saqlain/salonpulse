"""Disposable local schemas only. Never disable append-only protection for cleanup."""
import json
import re
import sys
from uuid import uuid4
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url
from alembic import command
from alembic.config import Config
from app.core.config import Settings
from app.db.base import Base
import app.models

PATTERN = r'salonpulse_test_[a-f0-9]{32}'
MARKER = 'SalonPulse disposable tests'

def guarded_url():
    url=make_url(Settings().database_url.get_secret_value())
    assert (url.drivername,url.database,url.username,url.port)==('postgresql+psycopg','salonpulse_dev','salonpulse_app',5432)
    assert url.host in ('localhost','127.0.0.1','::1')
    return url

def public_snapshot():
    engine=create_engine(guarded_url(),hide_parameters=True,connect_args={"options":"-c search_path=public"})
    try:
        with engine.connect() as c:
            c.exec_driver_sql('SET TRANSACTION READ ONLY')
            return {name:sorted(str(v) for v in c.scalars(select(table.c.id))) for name,table in Base.metadata.tables.items()}
    finally:engine.dispose()

def verify_schema(connection,name):
    assert re.fullmatch(PATTERN,name), 'Not a disposable schema'
    row=connection.execute(text("SELECT obj_description(n.oid,'pg_namespace'),pg_get_userbyid(n.nspowner)=current_user FROM pg_namespace n WHERE n.nspname=:name"),{'name':name}).one()
    assert row==(MARKER,True), 'Unrecognized schema ownership/marker'

def test_engine(name):
    assert re.fullmatch(PATTERN,name)
    engine=create_engine(guarded_url(),hide_parameters=True,isolation_level='READ COMMITTED',pool_size=5,max_overflow=5,pool_timeout=5,pool_recycle=1800,pool_pre_ping=True,
        connect_args={'connect_timeout':5,'options':f'-c search_path={name} -c statement_timeout=10000 -c lock_timeout=5000'})
    with engine.connect() as c:
        verify_schema(c,name)
        assert c.scalar(text('SELECT current_schema()'))==name
    return engine

def create_schema():
    name='salonpulse_test_'+uuid4().hex
    engine=create_engine(guarded_url(),hide_parameters=True)
    try:
        with engine.begin() as c:
            c.exec_driver_sql('CREATE SCHEMA '+name)
            c.exec_driver_sql("COMMENT ON SCHEMA "+name+" IS '"+MARKER+"'")
        isolated=test_engine(name)
        try:
            with isolated.begin() as c:
                config=Config('alembic.ini');config.attributes['connection']=c;config.attributes['skip_logging_configuration']=True
                command.upgrade(config,'head')
        finally:isolated.dispose()
        return name
    except Exception:
        # Drop only this newly generated, marked schema, never application schemas.
        drop_schema(name)
        raise
    finally:engine.dispose()

def drop_schema(name):
    engine=create_engine(guarded_url(),hide_parameters=True)
    try:
        with engine.begin() as c:
            verify_schema(c,name)
            c.exec_driver_sql('DROP SCHEMA '+name+' CASCADE')
    finally:engine.dispose()

class DisposableSchema:
    def __init__(self):
        self.baseline=public_snapshot();self.name=create_schema();self.closed=False
        try:self.engine=test_engine(self.name)
        except Exception:
            drop_schema(self.name)
            raise
    def close(self):
        if self.closed:return
        self.engine.dispose();drop_schema(self.name);self.closed=True
        assert public_snapshot()==self.baseline,'Public data changed during isolated tests'

    def __enter__(self):return self
    def __exit__(self,*args):self.close()

if __name__=='__main__':
    try:
        if sys.argv[1]=='create':print(create_schema())
        elif sys.argv[1]=='drop':drop_schema(sys.argv[2]);print('Dropped owned disposable schema')
        elif sys.argv[1]=='snapshot':print(json.dumps(public_snapshot(),sort_keys=True))
        else:raise ValueError()
    except Exception:
        print('Isolated database safety check failed; private details suppressed.',file=sys.stderr)
        raise SystemExit(1) from None
