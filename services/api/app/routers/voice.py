from __future__ import annotations
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any, Optional, List, Dict
from datetime import datetime, timedelta, date
from zoneinfo import ZoneInfo
import os
import re
import base64

import dateparser
from dateparser.search import search_dates

from app.services.google_calendar import create_calendar_event  # você já tem
from app.services.google_calendar import GoogleCalendarError
from app.core.config import settings

router = APIRouter(prefix="/voice", tags=["voice"])

# --- Configuração de fuso e contatos (MVP) ---
DEFAULT_TZ = settings.calendar_default_timezone or "America/New_York"

# Opcional: mapa simples Nome -> e-mail (pode vir de ENV CONTACTS_JSON)
# Ex.: CONTACTS_JSON='{"Marcos":"marcos@empresa.com", "Douglas":"mdfloorsusa@gmail.com"}'
CONTACTS: Dict[str, str] = {}
import json
raw = os.getenv("CONTACTS_JSON")
if raw:
    try:
        CONTACTS = json.loads(raw)
    except Exception:
        CONTACTS = {}
else:
    CONTACTS = {}

# --- Modelos ---
class VoiceCommand(BaseModel):
    text: str
    timezone: Optional[str] = None  # exemplo: "America/New_York"

class EventResponse(BaseModel):
    ok: bool
    message: str
    details: Optional[Dict[str, Any]] = None

# --- New ConfirmBody model ---
class ConfirmBody(BaseModel):
    confirmation_token: str
    confirm: bool = True

# --- Helpers ---
VERBS_CREATE = ("marca", "marcar", "agenda", "agendar")
ASK_AGENDA_PAT = re.compile(r"(próxim[oa]s?\s+compromissos?|agenda|meus\s+compromissos)", re.I)

# --- Confirmation regex pattern ---
CONFIRM_PAT = re.compile(r"(confirmo|pode marcar|mesmo assim|força|pode seguir|pode criar)", re.I)

def _tz(tz: Optional[str]) -> ZoneInfo:
    try:
        return ZoneInfo(tz or DEFAULT_TZ)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)

def _parse_when(text: str, tz: ZoneInfo) -> Optional[datetime]:
    """Entende 'amanhã 9h', 'dia 20 às 15:30', 'daqui 1 mês', etc.
    Usa dateparser + search_dates e alguns fallbacks em PT-BR.
    """
    now = datetime.now(tz)
    # 1) Tenta parse direto
    dt = dateparser.parse(
        text,
        languages=["pt"],
        settings={
            "TIMEZONE": tz.key,
            "RETURN_AS_TIMEZONE_AWARE": True,
            "PREFER_DATES_FROM": "future",
            "RELATIVE_BASE": now,
        },
    )
    if dt:
        return dt

    # 2) Busca a primeira data reconhecida na frase
    try:
        found = search_dates(
            text,
            languages=["pt"],
            settings={
                "TIMEZONE": tz.key,
                "RETURN_AS_TIMEZONE_AWARE": True,
                "RELATIVE_BASE": now,
            },
        )
        if found:
            # found é uma lista de tuplas (trecho, datetime)
            return found[0][1]
    except Exception:
        pass

    # 3) Fallback rápido para 'amanhã' com hora opcional
    m = re.search(r"\bamanh[ãa]\b(?:.*?\bàs?\s*(\d{1,2})(?::(\d{2}))?)?", text, re.I)
    if m:
        hour = int(m.group(1) or 9)
        minute = int(m.group(2) or 0)
        return (now + timedelta(days=1)).replace(hour=hour, minute=minute, second=0, microsecond=0)

    # 4) Fallback para 'dia 20 [/[mês][/ano]] às HH[:MM]'
    m = re.search(r"\bdia\s+(\d{1,2})(?:/(\d{1,2})(?:/(\d{2,4}))?)?(?:.*?\bàs?\s*(\d{1,2})(?::(\d{2}))?)?", text, re.I)
    if m:
        d = int(m.group(1))
        mon = int(m.group(2) or now.month)
        yr = int(m.group(3) or now.year)
        # normaliza ano 2 dígitos
        if yr < 100:
            yr += 2000
        hr = int(m.group(4) or 9)
        mi = int(m.group(5) or 0)
        try:
            return datetime(yr, mon, d, hr, mi, tzinfo=tz)
        except ValueError:
            return None

    return None

def _parse_duration_minutes(text: str) -> Optional[int]:
    # 'por 2 horas', 'duração 90 min', '1h e 30', etc. (MVP bem prático)
    text = text.lower()
    m = re.search(r"(\d+)\s*h(oras?)?", text)
    if m:
        hours = int(m.group(1))
        mmin = re.search(r"(\d+)\s*m(in(utos)?)?", text)
        extra = int(mmin.group(1)) if mmin else 0
        return hours * 60 + extra
    m = re.search(r"(\d+)\s*m(in(utos)?)?", text)
    if m:
        return int(m.group(1))
    return None

def _guess_title(text: str) -> str:
    # Pega palavras após verbo e antes de tempo/lugar comuns
    # Ex.: "Hanna, marca reunião/visita/orçamento/reparo ..."
    m = re.search(r"(reuni[aã]o|visita|orçamento|orcamento|reparo|call|meeting)", text, re.I)
    return m.group(0).capitalize() if m else "Compromisso"

def _extract_location(text: str) -> Optional[str]:
    m = re.search(r"\b(no|na|em)\s+([A-Za-z0-9çãáéíóúâêô\-\s]+)", text, re.I)
    if m:
        loc = m.group(2).strip()
        # Evita capturar "amanhã", "às", etc.
        if not re.search(r"(amanh[ãa]|às|as\s|\bhoje\b|\bdia\b|\d{1,2}/\d{1,2})", loc, re.I):
            return loc[:100]
    return None

def _extract_attendees(text: str) -> Optional[List[Dict[str, Any]]]:
    emails = re.findall(r"[\w\.\-\+]+@[\w\.\-]+\.\w+", text)
    attendees: List[Dict[str, Any]] = [{"email": e} for e in emails]

    # nomes simples mapeados para e-mail via CONTACTS
    for name, email in CONTACTS.items():
        if re.search(rf"\b{name}\b", text, re.I):
            attendees.append({"email": email})

    # remove duplicados
    uniq = {}
    for a in attendees:
        uniq[a["email"].lower()] = a
    return list(uniq.values()) if uniq else None

def _intent(text: str) -> str:
    t = text.lower()
    if any(v in t for v in VERBS_CREATE):
        return "create"
    if ASK_AGENDA_PAT.search(t):
        return "agenda"
    # fallback: se tem algo que se parece com data/horário, tendemos a "create"
    return "create" if _parse_when(t, _tz(None)) else "agenda"

from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials
from app.services.google_calendar import _load_oauth_user_credentials, _get_calendar_id

# --- Conflict and token helpers ---
def _find_conflicts(start: datetime, end: datetime, tz: ZoneInfo):
    creds: Credentials = _load_oauth_user_credentials()
    service = build("calendar", "v3", credentials=creds, cache_discovery=False)

    events_result = service.events().list(
        calendarId=_get_calendar_id(),
        timeMin=(start - timedelta(hours=6)).isoformat(),
        timeMax=(end + timedelta(hours=6)).isoformat(),
        singleEvents=True,
        orderBy="startTime",
    ).execute()
    items = events_result.get("items", [])

    conflicts = []
    for ev in items:
        s = ev["start"].get("dateTime") or ev["start"].get("date")
        e = ev["end"].get("dateTime") or ev["end"].get("date")
        try:
            sdt = dateparser.parse(s).astimezone(tz)
            edt = dateparser.parse(e).astimezone(tz)
            if not (edt <= start or sdt >= end):
                conflicts.append((ev, sdt, edt))
        except Exception:
            continue
    return conflicts

def _encode_token(data: Dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(data).encode()).decode()

def _decode_token(token: str) -> Dict[str, Any]:
    return json.loads(base64.urlsafe_b64decode(token.encode()).decode())

# --- Rotas ---
@router.post("/handle", response_model=EventResponse)
def handle_voice(cmd: VoiceCommand):
    """
    Interpreta um comando de voz em PT-BR.
    - 'Hanna, marca reunião amanhã às 9 com Marcos no escritório'
    - 'Hanna, quais meus próximos compromissos?'
    """
    text = cmd.text.strip()
    intent = _intent(text)
    tz = _tz(cmd.timezone)

    if intent == "agenda":
        # Hoje ou amanhã?
        if re.search(r"\bamanh[ãa]\b", text, re.I):
            day = datetime.now(tz).date() + timedelta(days=1)
        else:
            day = datetime.now(tz).date()
        items = _list_events_day(day, tz)
        if not items:
            when_label = "amanhã" if day == datetime.now(tz).date() + timedelta(days=1) else "hoje"
            return EventResponse(ok=True, message=f"Você não tem compromissos {when_label}.")
        lines = []
        for ev in items:
            start = ev['start'].get('dateTime') or ev['start'].get('date')
            title = ev.get('summary', 'Sem título')
            try:
                dt = dateparser.parse(start)
                lines.append(f"{dt.astimezone(tz).strftime('%H:%M')} - {title}")
            except Exception:
                lines.append(title)
        return EventResponse(ok=True, message="; ".join(lines), details={"events": items})

    # intent == "create"
    title = _guess_title(text)
    location = _extract_location(text)
    attendees = _extract_attendees(text)
    duration = _parse_duration_minutes(text) or 60

    when = _parse_when(text, tz)
    if not when:
        raise HTTPException(status_code=400, detail="Não entendi a data/horário. Tente: 'amanhã às 9h' ou 'dia 20 às 15h'.")

    start = when
    end = when + timedelta(minutes=duration)

    # Se o usuário já disse algo como "confirmo/mesmo assim", força a criação
    force = bool(CONFIRM_PAT.search(text))

    # Checa conflitos antes de criar
    conflicts = _find_conflicts(start, end, tz)
    if conflicts and not force:
        ev, sdt, edt = conflicts[0]
        t = ev.get("summary", "Compromisso")
        msg = (f"Douglas, você já tem '{t}' de {sdt.strftime('%H:%M')} a {edt.strftime('%H:%M')} nesse horário. "
               f"Quer marcar mesmo assim?")
        pending = {
            "title": title,
            "location": location,
            "attendees": attendees,
            "duration": duration,
            "start_iso": start.isoformat(),
            "tz": tz.key,
            "original_text": text,
        }
        token = _encode_token(pending)
        return EventResponse(
            ok=False,
            message=msg,
            details={"needs_confirmation": True, "confirmation_token": token, "conflicts": [ev]},
        )

    try:
        res = create_calendar_event(
            title=title,
            description=f"Criado por voz: “{text}”.",
            location=location,
            start=start,
            end=None,
            duration_minutes=duration,
            timezone=tz.key,
            attendees=attendees,
        )
        link = res.get("htmlLink")
        when_pt = start.strftime("%d/%m %H:%M")
        return EventResponse(
            ok=True,
            message=f"{title} marcado para {when_pt} ({tz.key}).",
            details={"event": res, "link": link},
        )
    except GoogleCalendarError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ====== LISTAGEM DE AGENDA (MVP) ======

def _list_events_day(day: date, tz: ZoneInfo):
    creds: Credentials = _load_oauth_user_credentials()
    service = build("calendar", "v3", credentials=creds, cache_discovery=False)

    start = datetime(day.year, day.month, day.day, 0, 0, tzinfo=tz)
    end = start + timedelta(days=1)

    time_min = start.isoformat()
    time_max = end.isoformat()

    events_result = service.events().list(
        calendarId=_get_calendar_id(),
        timeMin=time_min,
        timeMax=time_max,
        singleEvents=True,
        orderBy="startTime",
    ).execute()

    return events_result.get("items", [])


# --- Confirm pending event creation ---
@router.post("/confirm", response_model=EventResponse)
def confirm_voice(body: ConfirmBody):
    if not body.confirm:
        return EventResponse(ok=True, message="Ok, não vou criar esse evento agora.")
    try:
        data = _decode_token(body.confirmation_token)
        tz = _tz(data.get("tz"))
        start = datetime.fromisoformat(data["start_iso"])
        res = create_calendar_event(
            title=data["title"],
            description=f"Criado por voz (confirmado): “{data.get('original_text','')}”.",
            location=data.get("location"),
            start=start,
            end=None,
            duration_minutes=int(data.get("duration", 60)),
            timezone=tz.key,
            attendees=data.get("attendees"),
        )
        link = res.get("htmlLink")
        return EventResponse(
            ok=True,
            message=f"Confirmado. Evento criado para {start.strftime('%d/%m %H:%M')} ({tz.key}).",
            details={"event": res, "link": link},
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Token inválido ou expirado: {e}")
