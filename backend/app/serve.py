"""Secure single-process launcher; the app alone interprets trusted proxy headers."""

import argparse
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    arguments = parser.parse_args()
    from pydantic import ValidationError
    from pydantic_settings import SettingsError
    try:
        from app.core.config import settings  # validate before server startup
    except (ValidationError, SettingsError, ValueError):
        print("Invalid application configuration; review deployment settings privately.", file=sys.stderr)
        return 78
    import uvicorn
    uvicorn.run("app.main:app", host=arguments.host, port=arguments.port, workers=1,
                proxy_headers=False, access_log=False, server_header=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
