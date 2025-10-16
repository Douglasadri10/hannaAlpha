from __future__ import annotations

import os
import json
import datetime as dt
from typing import List, Optional, Dict, Any

from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request


class GoogleCalendarError(Exception):
    """Erro de integração com o Google Calendar."""
    pass


# ===== Helpers =====

def _creds_path() -> str:
    """Devolve o caminho do arquivo de credenciais salvo pelo OAuth callback."""
    return os.getenv("GOOGLE_CREDENTIALS_JSON_PATH", "/tmp/gcp.json")


def _load_creds() -> Credentials:
    """Reconstrói Credentials a partir do JSON salvo no callback.

    Espera um JSON com chaves: token, refresh_token (opcional), token_uri,
    client_id, client_secret, scopes.
    """
    path = _creds_path()
    if not os.path.exists(path):
        raise GoogleCalendarError(
            f"Credenciais não encontradas em {path}. Acesse /google/oauth/start para autorizar.")

    try:
        with open(path, "r") as f:
            data = json.load(f)
    except Exception as e:
        raise GoogleCalendarError(f"Falha ao ler credenciais em {path}: {e}")

    required = ["token", "token_uri", "client_id", "client_secret", "scopes"]
    missing = [k for k in required if not data.get(k)]
    if missing:
        raise GoogleCalendarError(
            "Arquivo de credenciais incompleto (faltando: " + ", ".join(missing) + "). Refaça o OAuth.")

    creds = Credentials(
        token=data.get("token"),
        refresh_token=data.get("refresh_token"),
        token_uri=data["token_uri"],
        client_id=data["client_id"],
        client_secret=data["client_secret"],
        scopes=data["scopes"],
    )

    # Atualiza access token se expirado
    if not creds.valid and creds.refresh_token:
        try:
            creds.refresh(Request())
            # persiste o novo token no mesmo arquivo
            data["token"] = creds.token
            with open(path, "w") as f:
                json.dump(data, f)
        except Exception as e:
            raise GoogleCalendarError(f"Falha ao renovar token: {e}")

    return creds


def _calendar_id() -> str:
    """Calendar ID alvo; usa primary por padrão."""
    return os.getenv("GOOGLE_CALENDAR_ID", "primary")


def _build_service():
    creds = _load_creds()
    # cache_discovery=False evita gravação de cache em disco (útil em containers)
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


# ===== API usada pelo router/tool =====

def create_calendar_event(
    title: str,
    start: str,
    end: Optional[str] = None,
    duration_minutes: Optional[int] = None,
    timezone: str = "UTC",
    description: Optional[str] = None,
    location: Optional[str] = None,
    attendees: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Cria um evento no Google Calendar usando as credenciais salvas via OAuth.

    `start`/`end` devem ser ISO 8601 (ex.: "2025-10-20T08:00:00-03:00").
    Se `end` não for informado, será calculado a partir de `duration_minutes`.
    """
    # Calcula `end` se necessário
    if not end:
        if not duration_minutes:
            raise GoogleCalendarError("Informe `end` ou `duration_minutes`.")
        try:
            start_dt = dt.datetime.fromisoformat(start)
        except Exception as e:
            raise GoogleCalendarError(f"`start` inválido: {e}")
        end_dt = start_dt + dt.timedelta(minutes=duration_minutes)
        end = end_dt.isoformat()

    event: Dict[str, Any] = {
        "summary": title,
        "description": description or "",
        "location": location or "",
        "start": {"dateTime": start, "timeZone": timezone},
        "end": {"dateTime": end, "timeZone": timezone},
    }
    if attendees:
        event["attendees"] = attendees

    try:
        service = _build_service()
        created = (
            service.events()
            .insert(calendarId=_calendar_id(), body=event, sendUpdates="all")
            .execute()
        )
        return {
            "id": created.get("id"),
            "status": created.get("status"),
            "htmlLink": created.get("htmlLink"),
        }
    except GoogleCalendarError:
        raise
    except Exception as e:
        raise GoogleCalendarError(f"Falha ao criar evento no Google Calendar: {e}")
