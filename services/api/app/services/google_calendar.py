"""Utilities for interacting with Google Calendar (OAuth user creds)."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any, Optional, Tuple
from zoneinfo import ZoneInfo

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.oauth2.credentials import Credentials  # OAuth user creds
from google.auth.transport.requests import Request

from app.core.config import settings

SCOPES = ["https://www.googleapis.com/auth/calendar"]


class GoogleCalendarError(RuntimeError):
    """Custom error raised when we cannot interact with Google Calendar."""


def _creds_path() -> str:
    path = settings.google_credentials_path
    if not path:
        raise GoogleCalendarError("GOOGLE_CREDENTIALS_JSON_PATH não configurada.")
    return path


def _load_oauth_user_credentials() -> Credentials:
    """Load OAuth *user* credentials saved by the OAuth callback.

    First tries to read the JSON file pointed by GOOGLE_CREDENTIALS_JSON_PATH.
    If the file does not exist but the env var GOOGLE_CREDENTIALS_JSON is set
    with a valid JSON payload, it will parse that payload, write it to the
    configured path, and use it. The JSON must contain: token, token_uri,
    client_id, client_secret, scopes. Optionally includes refresh_token.
    """
    path = _creds_path()

    data: dict[str, Any] | None = None

    # 1) Primary source: file on disk (preferred/persistent when using a Render Disk)
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                data = json.load(f)
        except (ValueError, json.JSONDecodeError) as exc:
            raise GoogleCalendarError("Credenciais Google inválidas (JSON).") from exc
    else:
        # 2) Fallback: env var with the full JSON (useful when a disk is not attached)
        raw = getattr(settings, "google_credentials_json", None)
        if raw:
            try:
                data = json.loads(raw)
                # Try to persist it so next calls find the file
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w") as f:
                    json.dump(data, f)
            except (ValueError, json.JSONDecodeError) as exc:
                raise GoogleCalendarError("GOOGLE_CREDENTIALS_JSON inválido (não é JSON).") from exc
        else:
            raise GoogleCalendarError(
                f"Arquivo de credenciais não encontrado: {path}. Autorize em /google/oauth/start.")

    required = ["token", "token_uri", "client_id", "client_secret", "scopes"]
    missing = [k for k in required if not data.get(k)]  # type: ignore[arg-type]
    if missing:
        raise GoogleCalendarError(
            "Credenciais Google inválidas. Faltando: " + ", ".join(missing)
        )

    creds = Credentials(
        token=data.get("token"),  # type: ignore[arg-type]
        refresh_token=data.get("refresh_token"),  # type: ignore[arg-type]
        token_uri=data["token_uri"],  # type: ignore[index]
        client_id=data["client_id"],  # type: ignore[index]
        client_secret=data["client_secret"],  # type: ignore[index]
        scopes=data["scopes"],  # type: ignore[index]
    )

    # Refresh if needed and persist updated access token
    if not creds.valid and creds.refresh_token:
        try:
            creds.refresh(Request())
            data["token"] = creds.token  # type: ignore[index]
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                json.dump(data, f)
        except Exception as exc:
            raise GoogleCalendarError(f"Falha ao renovar token: {exc}") from exc

    return creds


@lru_cache(maxsize=1)
def _get_calendar_id() -> str:
    calendar_id = settings.google_calendar_id.strip() if settings.google_calendar_id else ""
    # default to primary if not configured
    return calendar_id or "primary"


def _ensure_timezone(dt: datetime, tz_name: Optional[str]) -> Tuple[datetime, str]:
    """
    Guarantee the datetime has tzinfo by applying `tz_name` or the fallback timezone.

    Returns the timezone-aware datetime and the resolved timezone string.
    """
    resolved_tz = tz_name or settings.calendar_default_timezone
    try:
        zone = ZoneInfo(resolved_tz)
    except Exception as exc:  # pragma: no cover - zoneinfo raises generic Exception subclasses
        raise GoogleCalendarError(f"Timezone inválido: {resolved_tz}") from exc

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=zone)

    return dt.astimezone(zone), zone.key


def _compute_interval(
    start: datetime,
    end: Optional[datetime],
    duration_minutes: Optional[int],
    tz_name: Optional[str],
) -> Tuple[datetime, datetime, str]:
    start_dt, tz = _ensure_timezone(start, tz_name)

    if end:
        end_dt, _ = _ensure_timezone(end, tz_name or start_dt.tzinfo.key)  # reuse tz when not provided
    else:
        duration = duration_minutes or settings.calendar_default_duration_minutes
        if duration <= 0:
            raise GoogleCalendarError("Duração do evento deve ser positiva.")
        end_dt = start_dt + timedelta(minutes=duration)

    if end_dt <= start_dt:
        raise GoogleCalendarError("Horário final deve ser após o início.")

    return start_dt, end_dt, tz


def create_calendar_event(
    *,
    title: str,
    description: Optional[str],
    location: Optional[str],
    start: datetime,
    end: Optional[datetime],
    duration_minutes: Optional[int],
    timezone: Optional[str],
    attendees: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Insert an event into Google Calendar and return the API payload."""
    start_dt, end_dt, tz = _compute_interval(start, end, duration_minutes, timezone)

    event_body: dict[str, Any] = {
        "summary": title,
        "start": {
            "dateTime": start_dt.isoformat(),
            "timeZone": tz,
        },
        "end": {
            "dateTime": end_dt.isoformat(),
            "timeZone": tz,
        },
    }

    if description:
        event_body["description"] = description
    if location:
        event_body["location"] = location
    if attendees:
        event_body["attendees"] = attendees

    try:
        creds = _load_oauth_user_credentials()
        service = build("calendar", "v3", credentials=creds, cache_discovery=False)
        result = (
            service.events()
            .insert(calendarId=_get_calendar_id(), body=event_body, sendUpdates="all")
            .execute()
        )
    except HttpError as exc:
        raise GoogleCalendarError(exc.reason or "Erro ao acessar Google Calendar.") from exc

    return result
