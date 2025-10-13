from datetime import datetime
from typing import List, Optional

import paho.mqtt.publish as publish
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.config import settings
from app.services.google_calendar import GoogleCalendarError, create_calendar_event

router = APIRouter()

class SwitchLight(BaseModel):
    room: str
    state: str  # "on" | "off"

class SetAC(BaseModel):
    room: str
    temp: float

class CreateCalendarEvent(BaseModel):
    title: str = Field(..., description="Título curto e objetivo do compromisso.")
    start: datetime = Field(
        ...,
        description="Data/hora de início em ISO 8601 (ex.: 2024-10-20T08:00:00-03:00).",
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
        description="Timezone IANA (ex.: America/Sao_Paulo). Se vazio, usa padrão do sistema.",
    )
    location: Optional[str] = Field(None, description="Local do compromisso.")
    description: Optional[str] = Field(None, description="Detalhes adicionais.")
    attendees: Optional[List[str]] = Field(
        None,
        description="Lista de e-mails para convidar.",
    )

def mqtt_pub(topic: str, payload: str):
    auth = None
    if settings.mqtt_username:
        auth = {"username": settings.mqtt_username, "password": settings.mqtt_password or ""}
    publish.single(
        topic=topic,
        payload=payload,
        hostname=settings.mqtt_host,
        port=settings.mqtt_port,
        auth=auth
    )

@router.post("/tool/switchLight")
def tool_switch_light(body: SwitchLight):
    topic = f"{settings.mqtt_base_topic}/cmd/{body.room}/light"
    mqtt_pub(topic, body.state)
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
