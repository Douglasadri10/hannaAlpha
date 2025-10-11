from fastapi import APIRouter
from pydantic import BaseModel
import paho.mqtt.publish as publish
from app.core.config import settings

router = APIRouter()

class SwitchLight(BaseModel):
    room: str
    state: str  # "on" | "off"

class SetAC(BaseModel):
    room: str
    temp: float

class CreateCalendarEvent(BaseModel):
    title: str
    when: str

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
    # TODO: integrar Google Calendar; por enquanto, só ecoa
    return {"ok": True, "note": "Calendar TODO", "data": body.model_dump()}
