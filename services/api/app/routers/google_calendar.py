from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse
from google_auth_oauthlib.flow import Flow
import os
import json
from typing import Optional

router = APIRouter()

# Scopes we need for Calendar write access
SCOPES = [
    "https://www.googleapis.com/auth/calendar",
]


def _client_config():
    """Lê e valida as ENVs do OAuth, removendo espaços/quebras de linha."""
    def g(name: str) -> str:
        v = os.getenv(name)
        return v.strip() if isinstance(v, str) else ""

    client_id = g("GOOGLE_OAUTH_CLIENT_ID")
    client_secret = g("GOOGLE_OAUTH_CLIENT_SECRET")
    redirect_uri = g("GOOGLE_OAUTH_REDIRECT_URI")

    missing = [n for n, v in {
        "GOOGLE_OAUTH_CLIENT_ID": client_id,
        "GOOGLE_OAUTH_CLIENT_SECRET": client_secret,
        "GOOGLE_OAUTH_REDIRECT_URI": redirect_uri,
    }.items() if not v]
    if missing:
        raise HTTPException(status_code=500, detail=f"OAuth config ausente: {', '.join(missing)}")

    # validação básica
    if not client_id.endswith(".apps.googleusercontent.com"):
        raise HTTPException(status_code=500, detail="CLIENT_ID inválido (deve terminar com .apps.googleusercontent.com)")
    if not redirect_uri.startswith("http"):
        raise HTTPException(status_code=500, detail="REDIRECT_URI inválido (precisa ser http/https)")

    cfg = {
        "web": {
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uris": [redirect_uri],
            "auth_uri": "https://accounts.google.com/o/oauth2/v2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }
    return cfg, redirect_uri


@router.get("/oauth/start")
def google_oauth_start():
    """Start the Google OAuth2 flow and redirect the user to Google's consent screen."""
    cfg, redirect_uri = _client_config()
    try:
        flow = Flow.from_client_config(cfg, scopes=SCOPES)
        flow.redirect_uri = redirect_uri
        auth_url, _ = flow.authorization_url(
            access_type="offline",
            include_granted_scopes=True,
            prompt="consent",
            redirect_uri=redirect_uri,
        )
        return RedirectResponse(auth_url)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Falha ao montar fluxo OAuth: {e}")


@router.get("/oauth/start/url")
def google_oauth_start_url():
    """Return the Google consent URL as plain text for quick debugging."""
    cfg, redirect_uri = _client_config()
    try:
        flow = Flow.from_client_config(cfg, scopes=SCOPES)
        flow.redirect_uri = redirect_uri
        auth_url, _ = flow.authorization_url(
            access_type="offline",
            include_granted_scopes=True,
            prompt="consent",
            redirect_uri=redirect_uri,
        )
        return {"auth_url": auth_url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Falha ao montar fluxo OAuth: {e}")


@router.get("/oauth/callback")
def google_oauth_callback(code: Optional[str] = None):
    """OAuth callback: exchange `code` for tokens and stash credentials.

    This endpoint expects the provider to redirect to our configured
    GOOGLE_OAUTH_REDIRECT_URI (which should be /google/oauth/callback on this API)
    with a `code` query parameter.
    """
    if not code:
        raise HTTPException(status_code=400, detail="Missing OAuth authorization code")

    # If Google redirected back with an error, surface it clearly
    from fastapi import Request

    cfg, redirect_uri = _client_config()

    flow = Flow.from_client_config(cfg, scopes=SCOPES)
    flow.redirect_uri = redirect_uri

    try:
        flow.fetch_token(code=code, redirect_uri=redirect_uri)
        creds = flow.credentials
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Falha ao trocar código por token: {e}")

    # Persist credentials if a path is provided
    dest_path = os.getenv("GOOGLE_CREDENTIALS_JSON_PATH")
    if dest_path:
        payload = {
            "token": creds.token,
            "refresh_token": getattr(creds, "refresh_token", None),
            "token_uri": creds.token_uri,
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "scopes": creds.scopes,
        }
        try:
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            with open(dest_path, "w") as f:
                json.dump(payload, f)
        except Exception as e:
            # Not fatal for the OAuth flow; the client may choose to save manually
            raise HTTPException(status_code=500, detail=f"Token recebido, mas falha ao salvar credenciais: {e}")

    return {
        "ok": True,
        "message": "Autorização concluída com sucesso!",
        "has_refresh_token": bool(getattr(flow.credentials, "refresh_token", None)),
        "where_saved": dest_path or None,
    }

@router.get("/oauth/debug")
def google_oauth_debug():
    """Return current OAuth env config (masked) and the computed consent URL.
    Útil para diagnosticar 404/redirect_uri_mismatch.
    """
    cfg, redirect_uri = _client_config()
    try:
        masked = {
            "client_id_prefix": cfg["web"]["client_id"][:8],
            "client_id_suffix": cfg["web"]["client_id"][-10:],
            "has_secret": bool(cfg["web"]["client_secret"]),
            "redirect_uris": cfg["web"]["redirect_uris"],
            "scopes": SCOPES,
        }
        flow = Flow.from_client_config(cfg, scopes=SCOPES)
        flow.redirect_uri = redirect_uri
        auth_url, _ = flow.authorization_url(
            access_type="offline",
            include_granted_scopes=True,
            prompt="consent",
            redirect_uri=redirect_uri,
        )
        return {"config": masked, "auth_url": auth_url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Debug falhou: {e}")
