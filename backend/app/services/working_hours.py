"""Shared hours validation for booking writes and staff schedule changes."""

from datetime import datetime, time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from pydantic import TypeAdapter, ValidationError

from app.schemas.working_hours import Hours


def ensure_working_hours(hours, start, end, timezone_name):
    if hours is None:
        raise HTTPException(422, "Staff working hours are not configured")
    try:
        days = TypeAdapter(Hours).validate_python(hours)
        if len({item.day for item in days}) != len(days):
            raise ValueError
        zone = ZoneInfo(timezone_name)
        local_start, local_end = start.astimezone(zone), end.astimezone(zone)
        day = next((item for item in days if item.day == (local_start.weekday() + 1) % 7), None)
        if day is not None:
            opening = datetime.combine(local_start.date(), time.fromisoformat(day.start), zone)
            closing = datetime.combine(local_start.date(), time.fromisoformat(day.end), zone)
            if opening <= local_start < local_end <= closing:
                return
    except (ValidationError, ValueError, ZoneInfoNotFoundError, OverflowError):
        raise HTTPException(422, "Invalid staff working hours or business timezone") from None
    raise HTTPException(422, "Appointment must fit within staff working hours in the business timezone")
