"use client";

import { useEffect, useRef, useState } from "react";

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

  // --- Agenda intent state (unificado no hotword) ---
  const pendingConfirmRef = useRef<string | null>(null);
  const [awaitingAgendaCmd, setAwaitingAgendaCmd] = useState(false);

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
    try {
      const res = await fetch(`${API_BASE}/voice/handle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, timezone: tz }),
      });
      const data = await res.json();
      await processServerReply(data);
    } catch (e) {
      console.warn("agenda handle error", e);
    }
  }

  async function processServerReply(data: any) {
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
      // Captura livre (uma frase final) e envia para /voice/confirm com o texto
      captureOnce(async (ans) => {
        try {
          const resp = await fetch(`${API_BASE}/voice/confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              confirmation_token: pendingConfirmRef.current,
              text: ans,
            }),
          });
          const follow = await resp.json();
          // Recursivo: se ainda faltar algo, ele volta com expecting_input true
          await processServerReply(follow);
        } catch (err) {
          console.warn("confirm error", err);
        } finally {
          pendingConfirmRef.current = null;
        }
      });
      return;
    }

    // Caso normal: nada a esperar — feche o gate depois de alguns segundos
    if (micActive) {
      setTimeout(() => setMicGate(false), 1200);
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

  function captureWindow(seconds: number, onFinalText: (t: string) => void) {
    const SR: any =
      (window as any).webkitSpeechRecognition ||
      (window as any).SpeechRecognition;
    if (!SR) return;
    const rec: any = new SR();
    rec.lang = "pt-BR";
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = true;

    let timeoutId: number | null = null;

    const armTimeout = () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        try {
          rec.stop();
        } catch {}
      }, Math.max(1000, seconds * 1000));
    };

    rec.onresult = (ev: any) => {
      const res = ev.results[ev.resultIndex];
      if (!res) return;
      if (res.isFinal) {
        const t = (res[0]?.transcript || "").trim();
        if (t) onFinalText(t);
        armTimeout(); // reinicia janela após cada final
      }
    };

    rec.onerror = () => {
      try {
        rec.stop();
      } catch {}
    };

    rec.onend = () => {
      if (timeoutId) window.clearTimeout(timeoutId);
    };

    try {
      rec.start();
      armTimeout();
    } catch {}
  }
  // Palavras-chave para reconhecer intenção de agenda (cliente)
  const AGENDA_INTENT =
    /(marc(a|ar)|agend(a|ar)|reuni(ão|ao)|visita|orçamento|orcamento|compromissos?|agenda|calend[aá]rio)/i;

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
      setStatus(
        "Hotword indisponível no navegador; use o botão 'Falar (segure)'."
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

      // Palavra exata apenas: 'hanna'
      if (/\bhanna\b/.test(text)) {
        setStatus("Hotword detectada: microfone liberado por 10s");
        setMicGate(true);
        setAwaitingAgendaCmd(true);
        if (wakeTimerRef.current) window.clearTimeout(wakeTimerRef.current);
        // Janela de fala natural (10s): envia todas as frases, backend decide
        captureWindow(8, async (cmd) => {
          if (!awaitingAgendaCmd) return;
          if (pendingConfirmRef.current) return; // aguardando follow‑up
          const normalized = cmd.trim();
          // Envia tudo: o backend decide se é chat (noop) ou agenda
          await handleAgendaText(normalized);
        });
        wakeTimerRef.current = window.setTimeout(() => {
          setMicGate(false);
          setAwaitingAgendaCmd(false);
          setStatus("Aguardando chamar 'Hanna'…");
        }, 10000);
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
      } else {
        console.warn("SpeechRecognition error:", e);
      }
    };

    try {
      // Inicia após o gesto do usuário (já ocorreu ao conectar)
      rec.start();
    } catch (err) {
      console.warn("SpeechRecognition start error:", err);
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
    setNegotiating(true);
    setStatus("Solicitando microfone…");

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 25_000); // 25s safety timeout

    try {
      // 0) Verifica dispositivos de áudio disponíveis
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === "audioinput");
      if (!mics.length) {
        setStatus(
          "Nenhum microfone foi encontrado. Conecte um microfone e recarregue a página."
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
      setStatus("Criando conexão WebRTC…");

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
          setStatus(
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
          setStatus("Falha na conexão. Encerrando…");
          teardown();
        }
      };
    } catch (err: any) {
      console.error("startSession erro:", err);
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
