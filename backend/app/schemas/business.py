from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class BusinessResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    name: str
    timezone: str
    currency: str
    created_at: datetime
    updated_at: datetime
