import os
from typing import Optional

from pydantic import BaseModel
from dotenv import load_dotenv, find_dotenv

# Load environment variables from .env (even if located in parent folder)
load_dotenv(find_dotenv(".env"))

class Settings(BaseModel):
    # Service
    port: int = int(os.getenv("PORT", "8080"))

    # OpenAI
    openai_api_key: Optional[str] = os.getenv("OPENAI_API_KEY")
    openai_realtime_model: str = os.getenv(
        "OPENAI_REALTIME_MODEL",
        "gpt-4o-realtime-preview-2024-12-17",
    )
    openai_voice: str = os.getenv("OPENAI_VOICE", "aria")

    # CORS (comma-separated)
    cors_origins: str = os.getenv(
        "CORS_ORIGINS",
        "https://hanna-alpha.vercel.app,https://hannaalpha.onrender.com",
    )

settings = Settings()
