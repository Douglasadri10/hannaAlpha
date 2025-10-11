from pydantic import BaseModel
from typing import Optional
import os

from dotenv import load_dotenv, find_dotenv

# Load environment variables from .env file (even if located in parent folder)
load_dotenv(find_dotenv(".env"))

class Settings(BaseModel):
    port: int = int(os.getenv("PORT", "8080"))
    openai_api_key: Optional[str] = os.getenv("OPENAI_API_KEY")
    openai_realtime_model: str = os.getenv("OPENAI_REALTIME_MODEL", "gpt-4o-realtime-preview-2024-12-17")
    openai_voice: str = os.getenv("OPENAI_VOICE", "aria")
    openai_project_id: Optional[str] = os.getenv("OPENAI_PROJECT_ID")
    openai_org_id: Optional[str] = os.getenv("OPENAI_ORG_ID")
    mqtt_host: str = os.getenv("MQTT_HOST", "localhost")
    mqtt_port: int = int(os.getenv("MQTT_PORT", "1883"))
    mqtt_username: Optional[str] = os.getenv("MQTT_USERNAME")
    mqtt_password: Optional[str] = os.getenv("MQTT_PASSWORD")
    mqtt_base_topic: str = os.getenv("MQTT_BASE_TOPIC", "hanna")
    log_level: str = os.getenv("LOG_LEVEL", "INFO")

settings = Settings()
