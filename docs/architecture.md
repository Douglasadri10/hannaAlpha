# Arquitetura (visão executiva)

Mic → Realtime WebRTC (OpenAI) → Tools (MQTT/Calendar) → Resposta por voz.

- **Apps/Web**: inicia sessão WebRTC com token efêmero retornado por **/session**.
- **API (FastAPI)**: gera token efêmero, recebe tool-calls do modelo e executa:
  - `switchLight(room, state)` via MQTT
  - `setAC(room, temp)` via MQTT
  - `createCalendarEvent(title, when)` via Google Calendar
- **MQTT**: broker Mosquitto (local). Tópicos base: `hanna/cmd/*`.

Pronta para **fase 2**: substituir Realtime por **Whisper + Ollama(Qwen) + XTTS** mantendo a mesma interface de tools.
