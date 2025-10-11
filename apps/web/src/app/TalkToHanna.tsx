"use client";
import { useState, useEffect, useRef } from "react";

export default function TalkToHanna() {
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [connected, setConnected] = useState(false);
  const [negotiating, setNegotiating] = useState(false);
  const [status, setStatus] = useState<string>("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  // Resolve modelo e voz do ambiente (com fallbacks)
  const MODEL =
    process.env.NEXT_PUBLIC_OPENAI_REALTIME_MODEL ||
    process.env.NEXT_PUBLIC_REALTIME_MODEL ||
    "gpt-4o-realtime-preview-2024-12-17";
  const VOICE = process.env.NEXT_PUBLIC_OPENAI_VOICE || "aria";
  const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8080";

  async function startSession() {
    if (negotiating || connected) return;
    setNegotiating(true);
    setStatus("Solicitando microfone…");

    try {
      // 1) Pega microfone
      const local = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = local;

      // 2) Cria o peer com STUN
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      setStatus("Criando conexão WebRTC…");

      // 3) Áudio remoto
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioRef.current = audioEl;
      peer.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
      };
      document.body.appendChild(audioEl);

      // 4) Adiciona trilhas locais
      local.getTracks().forEach((t) => peer.addTrack(t, local));

      // 5) Offer
      const offer = await peer.createOffer({ offerToReceiveAudio: true });
      await peer.setLocalDescription(offer);

      // 6) Pega token efêmero do backend
      setStatus("Criando sessão Realtime…");
      const res = await fetch(`${API_BASE}/session`, { method: "POST" });
      if (!res.ok) {
        const txt = await res.text();
        console.error("Falha /session:", res.status, txt);
        alert("Erro criando sessão Realtime. Veja o console.");
        setNegotiating(false);
        return;
      }
      const data = await res.json();

      // 7) Negocia SDP com a OpenAI (inclui voice na query)
      setStatus("Negociando SDP com Realtime…");
      const sdpResp = await fetch(
        `https://api.openai.com/v1/realtime?model=${encodeURIComponent(
          MODEL
        )}&voice=${encodeURIComponent(VOICE)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${data.client_secret.value}`, // token efêmero
            "Content-Type": "application/sdp",
            "OpenAI-Beta": "realtime=v1",
          },
          body: offer.sdp || "",
        }
      );
      if (!sdpResp.ok) {
        const txt = await sdpResp.text();
        console.error("Falha SDP:", sdpResp.status, txt);
        alert("Erro na negociação SDP. Veja o console.");
        setNegotiating(false);
        return;
      }

      const answerText = await sdpResp.text();
      const answer: RTCSessionDescriptionInit = {
        type: "answer",
        sdp: answerText,
      };
      await peer.setRemoteDescription(new RTCSessionDescription(answer));

      // 8) Monitora estado
      peer.onconnectionstatechange = () => {
        setStatus(`Estado: ${peer.connectionState}`);
        if (peer.connectionState === "connected") setConnected(true);
        if (
          peer.connectionState === "disconnected" ||
          peer.connectionState === "failed" ||
          peer.connectionState === "closed"
        ) {
          cleanup();
        }
      };

      setPc(peer);
      setNegotiating(false);
      setStatus(`Conectado. Voz: ${VOICE}. Fale com a Hanna!`);
    } catch (err: any) {
      console.error("startSession erro:", err);
      if (err?.name === "NotAllowedError") {
        alert("Permissão de microfone negada. Habilite para continuar.");
      } else {
        alert("Falha ao iniciar a sessão. Veja o console para detalhes.");
      }
      setNegotiating(false);
    }
  }

  function cleanup() {
    setConnected(false);
    setStatus("Desconectado.");
    try {
      pc?.getSenders().forEach((s) => s.track?.stop());
      pc?.close();
    } catch {}
    setPc(null);

    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.srcObject = null;
        document.body.removeChild(audioRef.current);
      } catch {}
      audioRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
  }

  // ESC para desligar rápido
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cleanup();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Cleanup ao desmontar
  useEffect(() => {
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main
      style={{
        backgroundColor: "#0d0d0d",
        color: "#fff",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        gap: 16,
        padding: 24,
      }}
    >
      <h1 style={{ fontSize: "2rem" }}>
        {connected ? "🎙️ Hanna está te ouvindo..." : "Falar com a Hanna"}
      </h1>
      <div style={{ opacity: 0.7, fontSize: 14 }}>{status}</div>

      {!connected ? (
        <button
          onClick={startSession}
          disabled={negotiating}
          style={{
            backgroundColor: "#6366f1",
            border: "none",
            padding: "1rem 2rem",
            borderRadius: 12,
            fontSize: "1.2rem",
            color: "#fff",
            cursor: negotiating ? "not-allowed" : "pointer",
          }}
        >
          {negotiating ? "Conectando..." : "Iniciar conversa"}
        </button>
      ) : (
        <div style={{ display: "flex", gap: 12 }}>
          <button
            onClick={cleanup}
            style={{
              backgroundColor: "#ef4444",
              border: "none",
              padding: "1rem 2rem",
              borderRadius: 12,
              fontSize: "1.2rem",
              color: "#fff",
              cursor: "pointer",
            }}
            title="Encerrar (Esc)"
          >
            Desconectar
          </button>
        </div>
      )}
    </main>
  );
}
