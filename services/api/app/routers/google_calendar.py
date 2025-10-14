from fastapi import APIRouter
from fastapi.responses import RedirectResponse
from google_auth_oauthlib.flow import Flow
import os

router = APIRouter()

@router.get("/oauth/start")
def google_oauth_start():
    flow = Flow.from_client_config(
        {
            "web": {
                "client_id": os.getenv("GOOGLE_OAUTH_CLIENT_ID"),
                "client_secret": os.getenv("GOOGLE_OAUTH_CLIENT_SECRET"),
                "redirect_uris": [os.getenv("GOOGLE_OAUTH_REDIRECT_URI")],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token"
            }
        },
        scopes=["https://www.googleapis.com/auth/calendar"]
    )
    auth_url, _ = flow.authorization_url(prompt="consent")
    return RedirectResponse(auth_url)


@router.get("/oauth/callback")
def google_oauth_callback(code: str):
    return {"message": "Autorização concluída com sucesso!", "code": code}
