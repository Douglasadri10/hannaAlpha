# Hanna – Assistente Residencial (Monorepo)

Arquitetura pensada para **OpenAI Realtime (fase 1)** e pronta para migrar para **stack local (fase 2)**.

## Estrutura

- apps/web → Frontend (Next.js, WebRTC com Realtime API)
- services/api → Backend (FastAPI) com endpoints:
  - /health
  - /session (gera token efêmero p/ Realtime)
  - /tool (handlers: switchLight, setAC, createCalendarEvent)
  - /feedback (logger)
- services/mqtt → config Mosquitto
- local → diretórios futuros para Ollama/Whisper/XTTS
- packages/shared → Schemas e tipos compartilhados (TS/JSON)
- docs → documentação técnica
- scripts → utilidades (dev, lint, etc.)
- data → logs/armazenamento/tmp

## Primeiros passos
1) Copie `.env.example` para `.env` e ajuste as variáveis.  
2) Frontend: `cd apps/web` e **crie o Next** (ex.: `pnpm dlx create-next-app@latest . --ts --app`).  
3) Backend: `cd services/api && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8080`  
4) (Opcional) Docker Compose: veja `infra/compose/docker-compose.openai.yml`.

