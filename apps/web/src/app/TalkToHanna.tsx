"use client";
import { useEffect, useRef, useState } from "react";

// Loose typings for Web Speech API (browser-provided)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognition = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognitionEvent = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognitionResult = any;

/**
 * WebRTC client for Hanna (OpenAI Realtime) com hotword e push‑to‑talk.
 * - Gating de microfone: só envia áudio após detectar "Hanna" (ou PTT).
 * - Timeout/AbortController para evitar travas.
 * - UX de conexão e desligar (Esc).
 */
export default function TalkToHanna() {
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [connected, setConnected] = useState(false);
  const [negotiating, setNegotiating] = useState(false);
  const [status, setStatus] = useState<string>("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  // Hotword (Web Speech API)
  const SpeechRecognitionRef = useRef<(new () => SpeechRecognition) | null>(
    null
  );
  const recognizerRef = useRef<SpeechRecognition | null>(null);
  const wakeTimerRef = useRef<number | null>(null);

  // Gating state
  const [micActive, setMicActive] = useState(false);

  // ---------- Config from ENV (with sane fallbacks) ----------
  const MODEL =
    process.env.NEXT_PUBLIC_OPENAI_REALTIME_MODEL ||
    process.env.NEXT_PUBLIC_REALTIME_MODEL ||
    "gpt-4o-realtime-preview-2024-12-17";

  const VOICE = process.env.NEXT_PUBLIC_OPENAI_VOICE || "aria";

  // Prefer explicit API base; fallback to same-origin; last resort: localhost
  const API_BASE =
    (process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") as
      | string
      | undefined) ||
    (typeof window !== "undefined" ? window.location.origin : "") ||
    "http://localhost:8080";

  // join helper
  const api = (path: string) =>
    `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;

  // ---------- Helpers ----------
  function attachRemoteAudio(peer: RTCPeerConnection) {
    // Create (or reuse) audio element for remote stream
    if (!audioRef.current) {
      const el = document.createElement("audio") as HTMLAudioElement;
      el.autoplay = true;
      // TS-safe playsinline attribute
      el.setAttribute("playsinline", "true");
      el.style.display = "none";
      document.body.appendChild(el);
      audioRef.current = el;
    }
    peer.ontrack = (e) => {
      if (audioRef.current) {
        audioRef.current.srcObject = e.streams[0];
      }
    };
  }

  function setMicGate(on: boolean) {
    setMicActive(on);
    try {
      localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = on));
    } catch {}
  }

  function teardown() {
    // Desliga hotword
    try {
      recognizerRef.current?.stop();
    } catch {}
    if (wakeTimerRef.current) window.clearTimeout(wakeTimerRef.current);

    // Fecha mídia e peer
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
        // @ts-expect-error: srcObject é settable
        audioRef.current.srcObject = null;
        document.body.removeChild(audioRef.current);
      } catch {}
      audioRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    setMicGate(false);
  }

  // Allow Esc to hang up
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") teardown();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup when component unmounts
  useEffect(() => {
    return () => teardown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hotword listener (Web Speech API) — ativa gate ao detectar "Hanna" no INÍCIO da fala
  useEffect(() => {
    // @ts-expect-error: tipos dependem do navegador
    const SR: any =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    SpeechRecognitionRef.current = SR || null;
    if (!SR) {
      setStatus(
        "Hotword indisponível no navegador; use o botão 'Falar (segure)'."
      );
      return;
    }

    const rec: any = new SR();
    recognizerRef.current = rec;
    rec.lang = "pt-BR";
    rec.continuous = true;
    rec.interimResults = false;

    rec.onresult = (ev: SpeechRecognitionEvent) => {
      const text = Array.from(ev.results as any)
        .map((r: SpeechRecognitionResult) => r[0]?.transcript ?? "")
        .join(" ")
        .trim()
        .toLowerCase();

      const startsWithHanna =
        text.startsWith("hanna") ||
        text.startsWith("oi hanna") ||
        text.startsWith("hey hanna") ||
        text.startsWith("ei hanna");

      if (startsWithHanna) {
        setStatus("Hotword detectada: microfone liberado por 4s");
        setMicGate(true);
        if (wakeTimerRef.current) window.clearTimeout(wakeTimerRef.current);
        wakeTimerRef.current = window.setTimeout(() => {
          setMicGate(false);
          setStatus("Aguardando chamar 'Hanna'…");
        }, 4000);
      }
    };

    rec.onerror = () => {
      setStatus("Hotword falhou; use o botão 'Falar (segure)' para conversar.");
    };

    try {
      rec.start();
      setStatus((s) => (s ? s : "Aguardando chamar 'Hanna'…"));
    } catch {}

    return () => {
      try {
        rec.stop();
      } catch {}
      if (wakeTimerRef.current) window.clearTimeout(wakeTimerRef.current);
    };
  }, []);

  async function startSession() {
    if (negotiating || connected) return;
    setNegotiating(true);
    setStatus("Solicitando microfone…");

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 25_000); // 25s safety timeout

    try {
      // 1) Get mic
      const local = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = local;

      // Gate OFF por padrão (só hotword/PTT liga)
      local.getAudioTracks().forEach((t) => (t.enabled = false));
      setMicActive(false);

      // 2) PeerConnection (with public STUN)
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      setPc(peer);
      setStatus("Criando conexão WebRTC…");

      // 3) Remote audio
      attachRemoteAudio(peer);

      // 4) Add local tracks
      local.getTracks().forEach((t) => peer.addTrack(t, local));

      // 5) Offer
      const offer = await peer.createOffer({ offerToReceiveAudio: true });
      await peer.setLocalDescription(offer);

      // 6) Fetch ephemeral token from backend
      setStatus("Criando sessão Realtime…");
      const res = await fetch(api("/session"), {
        method: "POST",
        cache: "no-store",
        mode: "cors",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.error("Falha /session:", res.status, txt);
        alert("Erro criando sessão Realtime (backend). Veja o console.");
        throw new Error(`/session ${res.status}`);
      }

      const data: any = await res.json();
      const clientSecret: string | undefined = data?.client_secret?.value;
      if (!clientSecret) {
        console.error("Resposta /session inesperada:", data);
        alert("Resposta inesperada do backend (/session).");
        throw new Error("missing client_secret");
      }

      // 7) Exchange SDP with OpenAI Realtime (voice in query)
      setStatus("Negociando SDP com Realtime…");
      const sdpResp = await fetch(
        `https://api.openai.com/v1/realtime?model=${encodeURIComponent(
          MODEL
        )}&voice=${encodeURIComponent(VOICE)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${clientSecret}`,
            "Content-Type": "application/sdp",
            "OpenAI-Beta": "realtime=v1",
          },
          body: offer.sdp || "",
          signal: abort.signal,
        }
      );

      if (!sdpResp.ok) {
        const txt = await sdpResp.text().catch(() => "");
        console.error("Falha SDP:", sdpResp.status, txt);
        alert("Erro na negociação SDP com a OpenAI. Veja o console.");
        throw new Error(`sdp ${sdpResp.status}`);
      }

      const answerSdp = await sdpResp.text();
      await peer.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp: answerSdp })
      );

      // 8) Connection state feedback
      peer.oniceconnectionstatechange = () => {
        setStatus(`ICE: ${peer.iceConnectionState}`);
        if (
          peer.iceConnectionState === "connected" ||
          peer.iceConnectionState === "completed"
        ) {
          setConnected(true);
          setStatus(`Conectado. Voz: ${VOICE}. Diga: “Hanna, …” ou use PTT.`);
        }
        if (
          peer.iceConnectionState === "disconnected" ||
          peer.iceConnectionState === "failed" ||
          peer.iceConnectionState === "closed"
        ) {
          teardown();
        }
      };

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed") {
          setStatus("Falha na conexão. Encerrando…");
          teardown();
        }
      };
    } catch (err: any) {
      console.error("startSession erro:", err);
      if (err?.name === "NotAllowedError") {
        alert("Permissão de microfone negada. Habilite para continuar.");
      } else if (err?.name === "AbortError") {
        alert("Tempo esgotado ao conectar. Tente novamente.");
      } else {
        alert("Falha ao iniciar a sessão. Veja o console para detalhes.");
      }
      teardown();
    } finally {
      clearTimeout(timeout);
      setNegotiating(false);
    }
  }

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
            onMouseDown={() => setMicGate(true)}
            onMouseUp={() => setMicGate(false)}
            onTouchStart={() => setMicGate(true)}
            onTouchEnd={() => setMicGate(false)}
            style={{
              backgroundColor: micActive ? "#22c55e" : "#0ea5e9",
              border: "none",
              padding: "1rem 2rem",
              borderRadius: 12,
              fontSize: "1.2rem",
              color: "#fff",
              cursor: "pointer",
            }}
            title="Segure para falar"
          >
            {micActive ? "🎙️ Falando…" : "Falar (segure)"}
          </button>

          <button
            onClick={teardown}
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
