"""Public error contracts, including the sanitized validation response."""

from pydantic import BaseModel


class ValidationIssue(BaseModel):
    loc: list[str | int]
    msg: str
    type: str


class ErrorResponse(BaseModel):
    detail: str


class InvalidRequestResponse(BaseModel):
    detail: str | list[ValidationIssue]


API_ERRORS = {
    401: {"model": ErrorResponse, "description": "Missing or invalid Bearer authentication",
          "headers": {"WWW-Authenticate": {"schema": {"type": "string"}, "description": "Bearer"}}},
    403: {"model": ErrorResponse, "description": "Insufficient permissions"},
    404: {"model": ErrorResponse, "description": "Resource not found in the authenticated business"},
    409: {"model": ErrorResponse, "description": "Duplicate, booking or referenced-resource conflict"},
    422: {"model": InvalidRequestResponse, "description": "Invalid input or booking rules"},
    503: {"model": ErrorResponse, "description": "Database or authentication configuration unavailable"},
}
