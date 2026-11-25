from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator


class WorkingDay(BaseModel):
    model_config = ConfigDict(extra="forbid")
    day: Annotated[int, Field(strict=True, ge=0, le=6)]
    start: Annotated[str, StringConstraints(pattern=r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")]
    end: Annotated[str, StringConstraints(pattern=r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")]

    @model_validator(mode="after")
    def ordered_times(self):
        if self.end <= self.start:
            raise ValueError("Working-day end must be later than start; overnight shifts are not supported")
        return self


Hours = Annotated[list[WorkingDay], Field(min_length=1, max_length=7)]
