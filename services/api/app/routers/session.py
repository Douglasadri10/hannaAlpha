from fastapi import APIRouter, HTTPException
from app.core.config import settings
import httpx
from typing import Optional

router = APIRouter()

@router.post("/session")
async def create_realtime_session(
    model: Optional[str] = None,
    voice: Optional[str] = None,
    max_tokens: Optional[int] = None
):
    """
    Cria uma sessão efêmera no Realtime API e devolve credenciais para o browser completar o WebRTC.
    Obs: este endpoint deve ser protegido (CORS/CSRF) em produção.
    """
    if not settings.openai_api_key:
        raise HTTPException(500, "OPENAI_API_KEY não configurada")

    # Endpoint e payload seguem a doc do Realtime API.
    # Aqui fazemos uma chamada para criar a sessão (token efêmero).
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1",
    }
    if settings.openai_org_id:
        headers["OpenAI-Organization"] = settings.openai_org_id
    if settings.openai_project_id:
        headers["OpenAI-Project"] = settings.openai_project_id

    payload = {
        "model": (model or settings.openai_realtime_model),
        "voice": (voice or settings.openai_voice),
        "modalities": ["text", "audio"],
        "instructions": (
            "Você é a Hanna, brasileira, simpática, soando como se estivesse sorrindo. "
            "Regra de ouro: responda em 1 frase (8–18 palavras), direta e útil. "
            "Não repita a pergunta. Evite rodeios e formalidades. "
            "Ao usar ferramentas, confirme em 1 sentença o resultado. "
            "Otimize custo: mínimo de tokens sem perder clareza. "
            "Quando perguntarem seu nome, apresente-se como 'Hanna'."
        ),
           }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/realtime/sessions",
                headers=headers,
                json=payload
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError as e:
        # devolve o corpo de erro da OpenAI para facilitar o debug no front
        detail = e.response.text if e.response is not None else str(e)
        raise HTTPException(status_code=e.response.status_code if e.response else 502, detail=detail)
