import os, sys
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.routers import session, tool, feedback
from app.routers.google_calendar import router as google_router

# Garante que o FastAPI ache os módulos (app/...)
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

app = FastAPI(title="Hanna API", version="0.1.0")

# --- CORS CONFIG ---
# Origens vindas do .env/Render (CORS_ORIGINS CSV). Defaults cobrem Vercel + Render.
origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]

# Adiciona locais de dev sempre
for dev in ("http://localhost:3000", "http://127.0.0.1:3000"):
    if dev not in origins:
        origins.append(dev)

# Regex para liberar previews do Vercel (ex.: https://hanna-alpha-git-main-*.vercel.app)
origin_regex = r"https://hanna-alpha.*\.vercel\.app"

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_origin_regex=origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- HEALTHCHECK ---
@app.get("/health")
def health():
    return {"status": "ok"}

# --- PRE-FLIGHT DEDICADO (alguns proxies exigem explicitamente) ---
@app.options("/session")
def options_session_root():
    return Response(status_code=204)

# --- ROTAS ---
app.include_router(session.router, tags=["realtime"])
app.include_router(tool.router, tags=["tools"])
app.include_router(feedback.router, tags=["feedback"])
app.include_router(google_router, prefix="/google", tags=["google"])
