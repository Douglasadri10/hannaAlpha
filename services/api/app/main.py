import os, sys
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routers import session, tool, feedback

# Garante que o FastAPI ache os módulos
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

app = FastAPI(title="Hanna API", version="0.1.0")

# --- CORS CONFIG ---
origins_env = os.getenv(
    "CORS_ORIGINS",
    "https://hanna-alpha.vercel.app,https://hannaalpha.onrender.com"
)
origins = [o.strip() for o in origins_env.split(",") if o.strip()]

# Adiciona locais de dev
for dev in ["http://localhost:3000", "http://127.0.0.1:3000"]:
    if dev not in origins:
        origins.append(dev)

# Regex pro caso de subdomínios do Vercel (previews)
origin_regex = r"https://.*\.vercel\.app"

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

# --- ROTAS ---
app.include_router(session.router, tags=["realtime"])
app.include_router(tool.router, tags=["tools"])
app.include_router(feedback.router, tags=["feedback"])
