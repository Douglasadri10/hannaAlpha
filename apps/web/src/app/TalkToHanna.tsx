"use client";
import { useEffect, useRef, useState } from "react";

/**
 * WebRTC client for Hanna (OpenAI Realtime).
 * - Robust env resolution
 * - Safer CORS / timeouts
 * - Cleaner connect/disconnect UX (Esc to hang up)
 * - Better connection state/status messages
 */
export default function TalkToHanna() {
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [connected, setConnected] = useState(false);
  const [negotiating, setNegotiating] = useState(false);
  const [status, setStatus] = useState<string>("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

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
      // For TS compatibility on audio, set attribute instead of accessing a non-existent typed prop
      el.setAttribute("playsinline", "true");
      el.style.display = "none"; // keep DOM clean
      document.body.appendChild(el);
      audioRef.current = el;
    }
    peer.ontrack = (e) => {
      if (audioRef.current) {
        audioRef.current.srcObject = e.streams[0];
      }
    };
  }

  function teardown() {
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

  // Allow Esc to hang up
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") teardown();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Cleanup when component unmounts
  useEffect(() => {
    return () => teardown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          setStatus(`Conectado. Voz: ${VOICE}. Fale com a Hanna!`);
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
          setStatus("Falha na conexão. Tentando encerrar…");
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
