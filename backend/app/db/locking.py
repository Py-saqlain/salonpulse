"""Serialize booking and catalog changes within a business transaction."""

from fastapi import HTTPException
from sqlalchemy import select

from app.models import Business


def lock_business(session, scope, *, shared=False):
    # Writers use FOR NO KEY UPDATE; read snapshots use FOR SHARE. Readers can
    # coexist, while either mode excludes financial/booking writers.
    business = session.scalar(select(Business).where(Business.id == scope.business_id)
                              .with_for_update(read=shared, key_share=not shared).execution_options(populate_existing=True))
    if business is None:
        raise HTTPException(404, "Business not found")
    return business
