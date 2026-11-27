from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_owner_scope
from app.db.session import get_db
from app.db.tenant import TenantScope
from app.schemas.analytics import RevenueAnalytics, RevenueQuery
from app.services.analytics import revenue_analytics


router = APIRouter(prefix='/api/analytics', tags=['Analytics'])


@router.get('/revenue', response_model=RevenueAnalytics)
def revenue(scope: Annotated[TenantScope, Depends(get_owner_scope)],
            session: Annotated[Session, Depends(get_db)], query: Annotated[RevenueQuery, Query()]):
    return revenue_analytics(session, scope, query.date)
