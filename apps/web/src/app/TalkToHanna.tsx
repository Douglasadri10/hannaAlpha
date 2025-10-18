"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const tz =
  (typeof window !== "undefined" &&
    (Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York")) ||
  "America/New_York";

// Loose typings for Web Speech API (browser-provided)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognition = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognitionEvent = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognitionResult = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechGrammarList = any;

type LogLevel = "info" | "warn" | "error";

type LogEntry = {
  id: number;
  level: LogLevel;
  message: string;
  timestamp: Date;
  meta?: unknown;
};

const LOG_COLORS: Record<LogLevel, string> = {
  info: "#38bdf8",
  warn: "#facc15",
  error: "#f87171",
};

function formatLogTime(date: Date): string {
  try {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return date.toISOString().split("T")[1]?.slice(0, 8) ?? "";
  }
}

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

  // Debug log state
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsVisible, setLogsVisible] = useState(true);
  const logIdRef = useRef(0);
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  const pushLog = useCallback(
    (message: string, level: LogLevel = "info", meta?: unknown) => {
      logIdRef.current += 1;
      const entry: LogEntry = {
        id: logIdRef.current,
        level,
        message,
        timestamp: new Date(),
        meta,
      };
      setLogs((prev) => {
        const maxSize = 200;
        if (prev.length >= maxSize) {
          return [...prev.slice(prev.length - (maxSize - 1)), entry];
        }
        return [...prev, entry];
      });
      console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
        "[HannaLog]",
        message,
        meta ?? ""
      );
    },
    []
  );

  useEffect(() => {
    if (!logsVisible) return;
    const anchor = logsEndRef.current;
    if (anchor) {
      anchor.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, logsVisible]);

  const setStatusWithLog = useCallback(
    (text: string, level: LogLevel = "info") => {
      setStatus(text);
      pushLog(text, level);
    },
    [pushLog]
  );

  // Hotword (Web Speech API)
  const SpeechRecognitionRef = useRef<(new () => SpeechRecognition) | null>(
    null
  );
  const recognizerRef = useRef<SpeechRecognition | null>(null);
  const wakeTimerRef = useRef<number | null>(null);

  // Gating state
  const [micActive, setMicActive] = useState(false);

  // --- Agenda intent state (unificado no hotword) ---
  const pendingConfirmRef = useRef<string | null>(null);
  const awaitingAgendaRef = useRef(false);

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

  async function handleAgendaText(text: string) {
    pushLog(`Reconhecido: "${text}"`);
    try {
      const res = await fetch(`${API_BASE}/voice/handle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, timezone: tz }),
      });
      const data = await res.json();
      pushLog(`/voice/handle → ${res.status}`, "info", data);
      await processServerReply(data);
    } catch (e) {
      console.warn("agenda handle error", e);
      pushLog("Erro no /voice/handle", "error", e);
    }
  }

  async function processServerReply(data: any) {
    pushLog("Resposta recebida do backend", "info", data);
    // Se o backend sinaliza para não interferir (chit-chat), apenas ignore
    if (data?.details?.noop) return;

    // Se houver necessidade de confirmação OU de completar slots
    const expecting = Boolean(
      data?.expecting_input || data?.details?.needs_confirmation
    );
    const token = data?.details?.confirmation_token || data?.confirmation_token;

    if (expecting && token) {
      pendingConfirmRef.current = token;
      // mantenha o mic aberto visualmente durante a coleta
      setMicGate(true);
      awaitingAgendaRef.current = true;
      pushLog("Backend solicitou confirmação/complemento", "warn");
      // Modo de confirmação contínuo: mantém o mic aberto até silêncio (~4s)
      captureWindow(
        4000,
        async (ans) => {
          try {
            pushLog(`Enviando confirmação: "${ans}"`);
            const resp = await fetch(`${API_BASE}/voice/confirm`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                confirmation_token: pendingConfirmRef.current,
                text: ans,
              }),
            });
            pushLog(`/voice/confirm → ${resp.status}`);
            const follow = await resp.json();
            // Recursivo: se ainda faltar algo, ele volta com expecting_input true
            await processServerReply(follow);
          } catch (err) {
            console.warn("confirm error", err);
            pushLog("Erro no /voice/confirm", "error", err);
          } finally {
            pendingConfirmRef.current = null;
          }
        },
        () => {
          // silêncio detectado → fecha o gate de mic
          awaitingAgendaRef.current = false;
          setMicGate(false);
          pushLog("Janela de confirmação encerrada por silêncio");
        }
      );
      return;
    }
  }

  function captureOnce(onText: (t: string) => void) {
    const SR: any =
      (window as any).webkitSpeechRecognition ||
      (window as any).SpeechRecognition;
    if (!SR) return;
    const rec: any = new SR();
    rec.lang = "pt-BR";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    rec.onresult = (ev: any) => {
      const transcript = ev.results?.[0]?.[0]?.transcript?.trim();
      if (transcript) onText(transcript);
    };
    try {
      rec.start();
    } catch {}
  }

  function captureWindow(
    silenceMs: number,
    onFinalText: (t: string) => void,
    onStop?: () => void
  ) {
    const SR: any =
      (window as any).webkitSpeechRecognition ||
      (window as any).SpeechRecognition;
    if (!SR) return;
    const rec: any = new SR();
    rec.lang = "pt-BR";
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = true;
    pushLog(`Captura contínua iniciada (${silenceMs}ms ou silêncio)`);

    let silenceTimer: number | null = null;
    const armSilence = () => {
      if (silenceTimer) window.clearTimeout(silenceTimer);
      silenceTimer = window.setTimeout(() => {
        try {
          rec.stop();
        } catch {}
      }, Math.max(1000, silenceMs));
    };

    rec.onresult = (ev: any) => {
      const res = ev.results[ev.resultIndex];
      if (!res) return;
      // qualquer fala reinicia o timer de silêncio
      armSilence();
      if (res.isFinal) {
        const t = (res[0]?.transcript || "").trim();
        if (t) onFinalText(t);
        if (t) pushLog(`Transcrição finalizada: "${t}"`);
      }
    };

    rec.onerror = () => {
      pushLog("CaptureWindow erro no SpeechRecognition", "warn");
      try {
        rec.stop();
      } catch {}
    };

    rec.onend = () => {
      if (silenceTimer) window.clearTimeout(silenceTimer);
      onStop?.();
      pushLog("CaptureWindow finalizado");
    };

    try {
      rec.start();
      armSilence();
    } catch {}
  }
  // ---------- Helpers ----------
  function attachRemoteAudio(peer: RTCPeerConnection) {
    // Create (or reuse) audio element for remote stream
    if (!audioRef.current) {
      const el = document.createElement("audio") as HTMLAudioElement;
      el.autoplay = true;
      el.muted = false;
      el.volume = 1.0;
      // TS-safe playsinline attribute for iOS/Safari
      el.setAttribute("playsinline", "true");
      el.style.display = "none";
      document.body.appendChild(el);
      audioRef.current = el;
    }
    peer.ontrack = (e) => {
      if (audioRef.current) {
        audioRef.current.srcObject = e.streams[0];
        // Try to play immediately after a user gesture
        audioRef.current
          .play()
          .catch((err) => console.warn("audio play blocked:", err));
      }
    };
  }

  function setMicGate(on: boolean) {
    setMicActive(on);
    pushLog(on ? "Mic aberto" : "Mic fechado");
    try {
      localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = on));
    } catch {}
  }

  function teardown() {
    pushLog("Encerrando sessão/teardown");
    // Desliga hotword
    try {
      recognizerRef.current?.stop();
    } catch {}
    if (wakeTimerRef.current) window.clearTimeout(wakeTimerRef.current);

    // Fecha mídia e peer
    setConnected(false);
    setStatusWithLog("Desconectado.");
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
    awaitingAgendaRef.current = false;
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

  // Hotword listener (Web Speech API) — ativa somente quando conectado
  useEffect(() => {
    const SR: any =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    const SGL: SpeechGrammarList | undefined =
      (window as any).SpeechGrammarList ||
      (window as any).webkitSpeechGrammarList;

    SpeechRecognitionRef.current = SR || null;

    // Sem suporte, apenas informe e não tente rodar
    if (!SR) {
      setStatusWithLog(
        "Hotword indisponível no navegador; use o botão 'Falar (segure)'.",
        "warn"
      );
      return;
    }

    // Só mantenha o recognizer ativo quando conectado
    if (!connected) {
      try {
        recognizerRef.current?.abort?.();
        recognizerRef.current?.stop?.();
      } catch {}
      return;
    }

    // Evita múltiplas instâncias
    try {
      recognizerRef.current?.abort?.();
      recognizerRef.current?.stop?.();
    } catch {}

    const rec: any = new SR();
    recognizerRef.current = rec;

    // Tenta "forçar" o vocabulário prioritário para 'hanna'
    try {
      if (SGL) {
        const grammars = new (SGL as any)();
        // JSGF simples, dando peso maior para 'hanna'
        grammars.addFromString(
          "#JSGF V1.0; grammar wake; public &lt;wake&gt; = hanna;",
          1
        );
        rec.grammars = grammars;
      }
    } catch {}

    rec.lang = "pt-BR";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let restarting = false;
    const restart = (why: string) => {
      if (!connected || restarting) return;
      restarting = true;
      pushLog(`Hotword recognition reiniciando (${why})`, "warn");
      // pequeno backoff para não entrar em loop em erros como 'no-speech'
      setTimeout(() => {
        restarting = false;
        try {
          rec.start();
        } catch (err) {
          console.warn("SR restart fail:", err, "reason:", why);
        }
      }, 600);
    };

    rec.onstart = () => {
      // status apenas para debug leve
      // console.debug("SR onstart");
    };

    rec.onresult = (ev: SpeechRecognitionEvent) => {
      const text = Array.from(ev.results as any)
        .map((r: SpeechRecognitionResult) => r[0]?.transcript ?? "")
        .join(" ")
        .trim()
        .toLowerCase();
      if (text) pushLog(`Hotword reconhecimento parcial: "${text}"`);

      // Palavra exata apenas: 'hanna'
      if (/\bhanna\b/.test(text)) {
        setStatusWithLog("Hotword detectada: microfone liberado");
        setMicGate(true);
        awaitingAgendaRef.current = true;
        if (wakeTimerRef.current) window.clearTimeout(wakeTimerRef.current);
        // Janela natural baseada em silêncio: mantém aberto enquanto houver fala
        captureWindow(
          4000,
          async (cmd) => {
            if (!awaitingAgendaRef.current) return;
            if (pendingConfirmRef.current) return; // aguardando follow‑up
            const normalized = cmd.trim();
            // Envia tudo: o backend decide se é chat (noop) ou agenda
            await handleAgendaText(normalized);
          },
          () => {
            // encerrado por silêncio
            setMicGate(false);
            awaitingAgendaRef.current = false;
            setStatusWithLog("Aguardando chamar 'Hanna'…");
          }
        );
      }
    };

    rec.onaudioend = () => {
      // Chrome frequentemente chama 'no-speech' + encerra captura;
      // reiniciaremos com pequeno backoff
      restart("audioend");
    };

    rec.onend = () => {
      restart("end");
    };

    rec.onerror = (e: any) => {
      // Erros comuns:
      // 'no-speech' (sem fala por alguns segundos),
      // 'audio-capture' (mic ocupado/sem permissão),
      // 'network' (API remota do SR falhou),
      // 'aborted' (quando chamamos abort/stop).
      const et = (e?.error || "").toString();
      if (et === "aborted") return; // esperado ao trocar de estado
      if (et === "no-speech" || et === "network") {
        restart(et);
      } else if (et === "audio-capture") {
        // geralmente permissão ou conflito; apenas informe
        console.warn("SpeechRecognition sem acesso ao microfone.");
        pushLog("SpeechRecognition sem acesso ao microfone", "warn");
      } else {
        console.warn("SpeechRecognition error:", e);
        pushLog("SpeechRecognition erro inesperado", "error", e);
      }
    };

    try {
      // Inicia após o gesto do usuário (já ocorreu ao conectar)
      rec.start();
      pushLog("Hotword recognition iniciado");
    } catch (err) {
      console.warn("SpeechRecognition start error:", err);
      pushLog("Falha ao iniciar SpeechRecognition", "error", err);
    }

    return () => {
      try {
        rec.abort?.();
        rec.stop?.();
      } catch {}
      if (wakeTimerRef.current) window.clearTimeout(wakeTimerRef.current);
    };
  }, [connected]);

  async function startSession() {
    if (negotiating || connected) return;
    pushLog("Iniciando sessão WebRTC");
    setNegotiating(true);
    setStatusWithLog("Solicitando microfone…");

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 25_000); // 25s safety timeout

    try {
      // 0) Verifica dispositivos de áudio disponíveis
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === "audioinput");
      if (!mics.length) {
        setStatusWithLog(
          "Nenhum microfone foi encontrado. Conecte um microfone e recarregue a página.",
          "warn"
        );
        alert(
          "Nenhum microfone disponível. Conecte/ative um microfone e confira as permissões do navegador."
        );
        throw new Error("no-audio-input");
      }

      // Seleciona o primeiro mic disponível como padrão
      const chosen = mics[0];

      // 1) Tenta capturar áudio com constraints mais explícitas
      let local: MediaStream | null = null;
      const primaryConstraints: MediaStreamConstraints = {
        audio: {
          deviceId: chosen.deviceId ? { exact: chosen.deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      };

      try {
        local = await navigator.mediaDevices.getUserMedia(primaryConstraints);
      } catch (err: any) {
        // Fallback: tenta com constraints simples
        if (
          err?.name === "OverconstrainedError" ||
          err?.name === "NotFoundError"
        ) {
          local = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw err;
        }
      }

      if (!local) throw new Error("failed-to-getusermedia");

      localStreamRef.current = local;

      // Gate OFF por padrão (só hotword/PTT liga)
      local.getAudioTracks().forEach((t) => (t.enabled = false));
      setMicActive(false);

      // 2) PeerConnection (with public STUN)
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      setPc(peer);
      setStatusWithLog("Criando conexão WebRTC…");

      // 3) Remote audio
      attachRemoteAudio(peer);

      // 3.1) Receber áudio remoto explicitamente
      peer.addTransceiver("audio", { direction: "recvonly" });

      // 4) Add local tracks
      local.getTracks().forEach((t) => peer.addTrack(t, local!));

      // 5) Offer
      const offer = await peer.createOffer({ offerToReceiveAudio: true });
      await peer.setLocalDescription(offer);

      // 6) Fetch ephemeral token from backend
      setStatusWithLog("Criando sessão Realtime…");
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
      setStatusWithLog("Negociando SDP com Realtime…");
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
        setStatusWithLog(`ICE: ${peer.iceConnectionState}`);
        if (
          peer.iceConnectionState === "connected" ||
          peer.iceConnectionState === "completed"
        ) {
          setConnected(true);
          setStatusWithLog(
            `Conectado. Diga: “Hanna, …” e fale naturalmente (agenda inclusa).`
          );
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
          setStatusWithLog("Falha na conexão. Encerrando…", "warn");
          teardown();
        }
      };
    } catch (err: any) {
      console.error("startSession erro:", err);
      pushLog("startSession erro", "error", err);
      if (err?.name === "NotAllowedError") {
        alert("Permissão de microfone negada. Habilite para continuar.");
      } else if (
        err?.name === "NotFoundError" ||
        err?.message === "no-audio-input"
      ) {
        alert(
          "Nenhum dispositivo de áudio foi encontrado. Verifique se há um microfone conectado/selecionado e se as permissões do navegador estão ativas."
        );
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
    <>
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

      <div
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          width: logsVisible ? 360 : 200,
          backgroundColor: "rgba(12, 12, 12, 0.92)",
          color: "#e2e8f0",
          borderRadius: 12,
          border: "1px solid rgba(148, 163, 184, 0.2)",
          boxShadow: "0 12px 24px rgba(0,0,0,0.35)",
          fontFamily: "monospace",
          fontSize: 12,
          backdropFilter: "blur(6px)",
          zIndex: 50,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 12px",
            borderBottom: logsVisible
              ? "1px solid rgba(148, 163, 184, 0.2)"
              : "none",
            gap: 12,
          }}
        >
          <div style={{ fontWeight: 600 }}>
            Logs ({logs.length.toString().padStart(2, "0")})
          </div>
          <button
            onClick={() => setLogsVisible((prev) => !prev)}
            style={{
              backgroundColor: "transparent",
              border: "1px solid rgba(148, 163, 184, 0.4)",
              color: "#e2e8f0",
              padding: "4px 8px",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            {logsVisible ? "Ocultar" : "Mostrar"}
          </button>
        </div>

        {logsVisible && (
          <div
            style={{
              maxHeight: "45vh",
              overflowY: "auto",
              padding: "8px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {logs.length === 0 ? (
              <div style={{ opacity: 0.6 }}>
                Nenhum evento registrado ainda.
              </div>
            ) : (
              logs.map((entry) => {
                const meta =
                  entry.meta === undefined || entry.meta === null
                    ? null
                    : typeof entry.meta === "string"
                    ? entry.meta
                    : JSON.stringify(entry.meta, null, 2);
                return (
                  <div
                    key={entry.id}
                    style={{
                      borderLeft: `3px solid ${LOG_COLORS[entry.level]}`,
                      paddingLeft: 8,
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "baseline",
                      }}
                    >
                      <span style={{ opacity: 0.6 }}>
                        {formatLogTime(entry.timestamp)}
                      </span>
                      <span
                        style={{
                          color: LOG_COLORS[entry.level],
                          fontWeight: 600,
                        }}
                      >
                        {entry.level.toUpperCase()}
                      </span>
                    </div>
                    <div>{entry.message}</div>
                    {meta && (
                      <pre
                        style={{
                          margin: 0,
                          backgroundColor: "rgba(15, 23, 42, 0.6)",
                          padding: "6px 8px",
                          borderRadius: 6,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          maxHeight: 160,
                          overflow: "auto",
                        }}
                      >
                        {meta}
                      </pre>
                    )}
                  </div>
                );
              })
            )}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </>
  );
}
