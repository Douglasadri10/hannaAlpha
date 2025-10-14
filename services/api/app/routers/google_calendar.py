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
    """Build OAuth client config from env vars and validate required fields."""
    client_id = os.getenv("GOOGLE_OAUTH_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_OAUTH_CLIENT_SECRET")
    redirect_uri = os.getenv("GOOGLE_OAUTH_REDIRECT_URI")

    if not client_id or not client_secret or not redirect_uri:
        missing = [
            k for k, v in {
                "GOOGLE_OAUTH_CLIENT_ID": client_id,
                "GOOGLE_OAUTH_CLIENT_SECRET": client_secret,
                "GOOGLE_OAUTH_REDIRECT_URI": redirect_uri,
            }.items() if not v
        ]
        raise HTTPException(status_code=500, detail=f"OAuth config ausente: {', '.join(missing)}")

    cfg = {
        "web": {
            "client_id": client_id,
            "client_secret": client_secret,
            # keep also here because some libs read from client config
            "redirect_uris": [redirect_uri],
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }
    return cfg, redirect_uri


@router.get("/oauth/start")
def google_oauth_start():
    """Start the Google OAuth2 flow and redirect the user to Google's consent screen."""
    cfg, redirect_uri = _client_config()

    flow = Flow.from_client_config(cfg, scopes=SCOPES)
    # Explicitly set redirect_uri or Google may return redirect_uri_mismatch
    flow.redirect_uri = redirect_uri

    auth_url, _ = flow.authorization_url(
        access_type="offline",  # issue refresh token
        include_granted_scopes="true",
        prompt="consent",
    )
    return RedirectResponse(auth_url)


@router.get("/oauth/callback")
def google_oauth_callback(code: Optional[str] = None):
    """OAuth callback: exchange `code` for tokens and stash credentials.

    This endpoint expects the provider to redirect to our configured
    GOOGLE_OAUTH_REDIRECT_URI (which should be /google/oauth/callback on this API)
    with a `code` query parameter.
    """
    if not code:
        raise HTTPException(status_code=400, detail="Missing OAuth authorization code")

    cfg, redirect_uri = _client_config()

    flow = Flow.from_client_config(cfg, scopes=SCOPES)
    flow.redirect_uri = redirect_uri

    try:
        flow.fetch_token(code=code)
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
