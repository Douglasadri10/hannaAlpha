from datetime import datetime, timedelta
from enum import Enum
from typing import List, Optional

import paho.mqtt.publish as publish
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator
from zoneinfo import ZoneInfo

from app.core.config import settings
from app.services.google_calendar import (
    GoogleCalendarError,
    create_calendar_event,
)

router = APIRouter()

# ---------------------------
# Models
# ---------------------------
class LightState(str, Enum):
    on = "on"
    off = "off"


class SwitchLight(BaseModel):
    room: str
    state: LightState  # "on" | "off"

    @field_validator("room")
    @classmethod
    def _room_strip(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("room is required")
        return v


class SetAC(BaseModel):
    room: str
    temp: float = Field(..., ge=10, le=32, description="Temperatura desejada (°C)")


class CreateCalendarEvent(BaseModel):
    title: str = Field(..., description="Título curto e objetivo do compromisso.")
    start: datetime = Field(
        ..., description="Data/hora de início em ISO 8601 (ex.: 2024-10-20T08:00:00-03:00)."
    )
    end: Optional[datetime] = Field(
        None,
        description="Data/hora de término em ISO 8601. Usa duration_minutes se ausente.",
    )
    duration_minutes: Optional[int] = Field(
        None,
        ge=5,
        le=12 * 60,
        description="Duração em minutos quando `end` não for informado.",
    )
    timezone: Optional[str] = Field(
        None,
        description="Timezone IANA (ex.: America/Sao_Paulo). Se vazio, usa a do sistema.",
    )
    location: Optional[str] = Field(None, description="Local do compromisso.")
    description: Optional[str] = Field(None, description="Detalhes adicionais.")
    attendees: Optional[List[str]] = Field(
        None, description="Lista de e-mails para convidar.",
    )

    @model_validator(mode="after")
    def _normalize_and_validate(self) -> "CreateCalendarEvent":
        # Título enxuto
        self.title = self.title.strip()
        if not self.title:
            raise ValueError("title is required")

        # Define timezone para datetimes ingênuos (sem tzinfo)
        tz: Optional[ZoneInfo] = None
        if self.timezone:
            try:
                tz = ZoneInfo(self.timezone)
            except Exception as exc:  # noqa: BLE001
                raise ValueError(f"invalid timezone: {self.timezone}") from exc

        if self.start.tzinfo is None:
            self.start = self.start.replace(tzinfo=tz or ZoneInfo("UTC"))

        if self.end is not None and self.end.tzinfo is None:
            self.end = self.end.replace(tzinfo=self.start.tzinfo)

        # Gera `end` a partir de `duration_minutes` quando não vier explícito
        if self.end is None and (self.duration_minutes is not None):
            self.end = self.start + timedelta(minutes=self.duration_minutes)

        # Exige pelo menos `end` ou `duration_minutes`
        if self.end is None and self.duration_minutes is None:
            raise ValueError("provide either `end` or `duration_minutes`")

        return self


# ---------------------------
# Helpers
# ---------------------------

def mqtt_pub(topic: str, payload: str):
    auth = None
    if settings.mqtt_username:
        auth = {
            "username": settings.mqtt_username,
            "password": settings.mqtt_password or "",
        }
    try:
        publish.single(
            topic=topic,
            payload=payload,
            hostname=settings.mqtt_host,
            port=settings.mqtt_port,
            auth=auth,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"MQTT publish failed: {exc}")


# ---------------------------
# Routes
# ---------------------------
@router.post("/tool/switchLight")
def tool_switch_light(body: SwitchLight):
    topic = f"{settings.mqtt_base_topic}/cmd/{body.room}/light"
    mqtt_pub(topic, body.state.value)
    return {"ok": True}


@router.post("/tool/setAC")
def tool_set_ac(body: SetAC):
    topic = f"{settings.mqtt_base_topic}/cmd/{body.room}/ac"
    mqtt_pub(topic, str(body.temp))
    return {"ok": True}


@router.post("/tool/createCalendarEvent")
def tool_create_calendar_event(body: CreateCalendarEvent):
    attendees_payload = None
    if body.attendees:
        attendees_payload = [
            {"email": email.strip()}
            for email in body.attendees
            if email and email.strip()
        ] or None

    try:
        event = create_calendar_event(
            title=body.title,
            description=body.description,
            location=body.location,
            start=body.start,
            end=body.end,
            duration_minutes=body.duration_minutes,
            timezone=body.timezone,
            attendees=attendees_payload,
        )
    except GoogleCalendarError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return {
        "ok": True,
        "eventId": event.get("id"),
        "htmlLink": event.get("htmlLink"),
        "start": event.get("start"),
        "end": event.get("end"),
    }
