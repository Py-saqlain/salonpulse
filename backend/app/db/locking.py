"""Serialize booking and catalog changes within a business transaction."""

from fastapi import HTTPException
from sqlalchemy import select

from app.models import Business


def lock_business(session, scope):
    # FOR NO KEY UPDATE conflicts with other writers while allowing FK checks.
    business = session.scalar(select(Business).where(Business.id == scope.business_id)
                              .with_for_update(key_share=True).execution_options(populate_existing=True))
    if business is None:
        raise HTTPException(404, "Business not found")
    return business
