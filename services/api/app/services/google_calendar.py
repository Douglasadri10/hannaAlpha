"""Utilities for interacting with Google Calendar."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any, Optional, Tuple
from zoneinfo import ZoneInfo

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.oauth2.service_account import Credentials

from app.core.config import settings

SCOPES = ["https://www.googleapis.com/auth/calendar"]


class GoogleCalendarError(RuntimeError):
    """Custom error raised when we cannot interact with Google Calendar."""


@lru_cache(maxsize=1)
def _load_credentials() -> Credentials:
    """Load service-account credentials from disk."""
    path = settings.google_credentials_path
    if not path:
        raise GoogleCalendarError("GOOGLE_CREDENTIALS_JSON_PATH não configurada.")
    if not os.path.exists(path):
        raise GoogleCalendarError(f"Arquivo de credenciais não encontrado: {path}")

    try:
        creds = Credentials.from_service_account_file(path, scopes=SCOPES)
    except (ValueError, json.JSONDecodeError) as exc:
        raise GoogleCalendarError("Credenciais Google inválidas.") from exc

    if settings.google_impersonated_user:
        creds = creds.with_subject(settings.google_impersonated_user)

    return creds


@lru_cache(maxsize=1)
def _get_calendar_id() -> str:
    calendar_id = settings.google_calendar_id.strip() if settings.google_calendar_id else ""
    if not calendar_id:
        raise GoogleCalendarError("Configure GOOGLE_CALENDAR_ID com o ID do calendário ou e-mail.")
    return calendar_id


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

    creds = _load_credentials()
    try:
        service = build("calendar", "v3", credentials=creds, cache_discovery=False)
        result = (
            service.events()
            .insert(calendarId=_get_calendar_id(), body=event_body, sendUpdates="all")
            .execute()
        )
    except HttpError as exc:
        raise GoogleCalendarError(exc.reason or "Erro ao acessar Google Calendar.") from exc

    return result
