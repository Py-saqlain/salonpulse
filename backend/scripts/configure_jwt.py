"""Run locally to provision a signing key without displaying it. Not run on startup."""

from pathlib import Path
import re
import secrets

from dotenv import dotenv_values


def configure(path: Path) -> bool:
    if not path.is_file():
        raise ValueError("Create backend/.env privately first; existing configuration is never overwritten")
    existing = dotenv_values(path).get("JWT_SECRET_KEY")
    if existing:
        if len(existing.encode("utf-8")) < 32:
            raise ValueError("An existing key is too short; remove that line privately before provisioning")
        return False
    source = path.read_bytes().decode("utf-8")
    newline = "\r\n" if "\r\n" in source else "\n"
    assignment = "JWT_SECRET_KEY=" + secrets.token_urlsafe(32)
    pattern = r"(?m)^[ \t]*(?:export[ \t]+)?JWT_SECRET_KEY[ \t]*=[^\r\n]*"
    if re.search(pattern, source):
        updated = re.sub(pattern, lambda match: assignment, source)
    else:
        updated = source + (newline if source and not source.endswith("\n") else "") + assignment + newline
    path.write_bytes(updated.encode("utf-8"))
    return True


if __name__ == "__main__":
    path = Path(__file__).resolve().parents[1] / ".env"
    try:
        changed = configure(path)
    except (ValueError, OSError):
        raise SystemExit("Key setup stopped. Check that the private .env exists and has no existing invalid key; no key was displayed.") from None
    print("Signing key saved privately. Restart the backend." if changed else "Existing signing key retained. No changes made.")
