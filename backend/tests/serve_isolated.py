"""Test-only HTTP server. A verified disposable schema is mandatory."""
import os
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker
from app.core.config import Settings
from app.main import create_app
from app.db.session import get_db
from isolated_db import test_engine

engine=test_engine(os.environ['SALONPULSE_TEST_SCHEMA'])
config=Settings()
assert config.app_env=='development'
config=config.model_copy(update={'cors_origins':['http://127.0.0.1:5174','http://localhost:5174']})
app=create_app(config)
factory=sessionmaker(engine,expire_on_commit=False,autoflush=False)
def database():
    try:
        with factory() as session:yield session
    except SQLAlchemyError:
        raise HTTPException(503,'Database unavailable') from None
app.dependency_overrides[get_db]=database
if __name__=='__main__':
    import uvicorn
    from threading import Thread
    server=uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=int(sys.argv[1]),proxy_headers=False,access_log=False,server_header=False))
    def stop_on_parent_close():
        sys.stdin.buffer.read(1)
        server.should_exit=True
    Thread(target=stop_on_parent_close,daemon=True).start()
    try:server.run()
    finally:engine.dispose()
