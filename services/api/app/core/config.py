from fastapi import Response

@router.post("/session")
async def create_realtime_session(dry: bool = False):
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
    if dry:
        return {"payload": payload}

async def options_session():
    return Response(status_code=204)
