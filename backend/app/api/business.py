from typing import Annotated

from fastapi import APIRouter, Depends, Response

from app.api.dependencies import get_current_business
from app.models import Business
from app.schemas.business import BusinessResponse


router = APIRouter(prefix="/api/business", tags=["Business"])


@router.get("/me", response_model=BusinessResponse)
def business_profile(response: Response, business: Annotated[Business, Depends(get_current_business)]) -> Business:
    response.headers["Cache-Control"] = "no-store"
    return business
