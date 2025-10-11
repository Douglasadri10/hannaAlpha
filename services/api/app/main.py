import sys, os
# Add the parent directory of 'app' to sys.path so 'from app.routers ...' works
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routers import session, tool, feedback

app = FastAPI(title="Hanna API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://*.vercel.app",      # libera seu frontend na Vercel
        "https://seu-dominio.com",   # (opcional) domínio custom
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status": "ok"}

app.include_router(session.router, tags=["realtime"])
app.include_router(tool.router, tags=["tools"])
app.include_router(feedback.router, tags=["feedback"])
