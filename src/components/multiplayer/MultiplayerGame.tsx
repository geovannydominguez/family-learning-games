"use client";

import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent, type ReactNode } from "react";

import type { PublicGame } from "@/application/game/gameSessionContracts";
import type { MultiplayerClientAction, MultiplayerServerEvent, ScoreboardEntry } from "@/application/multiplayer/contracts";
import type { Difficulty } from "@/domain/game/types";
import type { Player } from "@/domain/player/types";
import { createGameApiClient } from "@/infrastructure/http/GameApiClient";
import { MultiplayerSocketClient, readMultiplayerSocketUrl, type MultiplayerConnectionStatus } from "@/infrastructure/websocket/MultiplayerSocketClient";
import { QuestionAudioButton, QuestionImageView } from "../game/QuestionMedia";
import {
  applyServerEvent,
  clearMultiplayerSession,
  initialMultiplayerViewState,
  isTerminalMultiplayerError,
  loadMultiplayerSession,
  multiplayerErrorMessage,
  questionTimeoutToSend,
  remainingSeconds,
  saveMultiplayerSession,
  type StoredMultiplayerSession,
} from "./multiplayerRoomState";

type Step = "menu" | "create-player" | "create-game" | "join-code" | "join-player" | "room";

const timeLimitOptions = [15, 30, 45, 60, 90];
const difficultyLabels: Record<Difficulty, string> = { easy: "Fácil", normal: "Normal", hard: "Difícil" };
const medals = ["🥇", "🥈", "🥉"];

/**
 * v0.9 multiplayer flow (FASE 9): create or join a room with an existing
 * family profile, then play over the WebSocket. Online only; the participant
 * token lives in sessionStorage for this tab and never in localStorage.
 */
export function MultiplayerGame({ players, onExit }: { players: Player[] | null; onExit: () => void }) {
  const [step, setStep] = useState<Step>("menu");
  const [session, setSession] = useState<StoredMultiplayerSession | null>(null);
  const [hostPlayer, setHostPlayer] = useState<Player | null>(null);
  const [games, setGames] = useState<PublicGame[] | null>(null);
  const [difficultyByGame, setDifficultyByGame] = useState<Record<string, Difficulty>>({});
  const [timeLimit, setTimeLimit] = useState(30);
  const [roomCode, setRoomCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resume an active room after a refresh in the same tab.
  useEffect(() => {
    const stored = loadMultiplayerSession();
    if (stored) {
      setSession(stored);
      setStep("room");
    }
  }, []);

  useEffect(() => {
    if (step !== "create-game" || games) return;
    createGameApiClient().listGames().then(setGames).catch((caught) => setError(multiplayerErrorMessage(caught, "No pudimos cargar los juegos.")));
  }, [step, games]);

  function enterRoom(next: StoredMultiplayerSession) {
    saveMultiplayerSession(next);
    setSession(next);
    setError(null);
    setStep("room");
  }

  async function createRoom(game: PublicGame) {
    if (!hostPlayer) return setStep("create-player");
    setSubmitting(true);
    setError(null);
    try {
      const difficulty = difficultyByGame[game.id] ?? game.difficulties[0];
      const created = await createGameApiClient().createMultiplayerRoom({
        gameId: game.id,
        playerId: hostPlayer.playerId,
        questionTimeLimitSeconds: timeLimit,
        ...(difficulty ? { difficulty } : {}),
      });
      enterRoom({ roomId: created.roomId, roomCode: created.roomCode, playerId: created.playerId, participantToken: created.participantToken });
    } catch (caught) {
      setError(multiplayerErrorMessage(caught, "No pudimos crear la sala."));
    } finally {
      setSubmitting(false);
    }
  }

  async function joinRoom(player: Player) {
    setSubmitting(true);
    setError(null);
    try {
      const joined = await createGameApiClient().joinMultiplayerRoom(roomCode, player.playerId);
      enterRoom({ roomId: joined.roomId, roomCode: joined.roomCode, playerId: joined.playerId, participantToken: joined.participantToken });
    } catch (caught) {
      setError(multiplayerErrorMessage(caught, "No pudimos unirte a la sala."));
    } finally {
      setSubmitting(false);
    }
  }

  function leaveRoom() {
    clearMultiplayerSession();
    setSession(null);
    setStep("menu");
  }

  if (step === "room" && session) return <MultiplayerRoomView session={session} onLeave={leaveRoom} />;

  if (step === "create-player" || step === "join-player") {
    const creating = step === "create-player";
    return (
      <Layout title="¿Quién eres?" description={creating ? "Elige tu perfil. Serás el anfitrión de la sala." : `Elige tu perfil para entrar a la sala ${roomCode}.`} error={error} onBack={() => setStep(creating ? "menu" : "join-code")}>
        <PlayerPicker players={players} disabled={submitting} onChoose={(player) => {
          if (creating) {
            setHostPlayer(player);
            setStep("create-game");
          } else {
            void joinRoom(player);
          }
        }} />
      </Layout>
    );
  }

  if (step === "create-game") return (
    <Layout title="Elige el juego" description={`Anfitrión: ${hostPlayer?.name ?? ""}. Todos responderán las mismas preguntas.`} error={error} onBack={() => setStep("create-player")}>
      <label htmlFor="time-limit" className="block text-lg font-black text-slate-900">Tiempo por pregunta</label>
      <select id="time-limit" value={timeLimit} disabled={submitting} onChange={(event) => setTimeLimit(Number(event.target.value))} className="mt-2 min-h-14 w-full max-w-xs rounded-2xl border-2 border-violet-200 bg-white px-4 text-lg font-bold outline-none focus-visible:ring-4 focus-visible:ring-violet-300">
        {timeLimitOptions.map((seconds) => <option key={seconds} value={seconds}>{seconds} segundos</option>)}
      </select>
      {!games ? <p className="mt-8 text-center text-lg text-slate-600">Cargando juegos…</p> : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {games.map((game) => (
            <div key={game.id} className="selection-card items-stretch text-left">
              <span className="text-5xl" aria-hidden="true">{game.category.icon || "✨"}</span>
              <span className="mt-3 block text-xl font-black text-slate-900">{game.title}</span>
              {game.difficulties.length > 1 && (
                <select aria-label={`Dificultad de ${game.title}`} value={difficultyByGame[game.id] ?? game.difficulties[0]} disabled={submitting} onChange={(event) => setDifficultyByGame((current) => ({ ...current, [game.id]: event.target.value as Difficulty }))} className="mt-3 min-h-11 rounded-xl border-2 border-violet-200 bg-white px-3 font-bold">
                  {game.difficulties.map((difficulty) => <option key={difficulty} value={difficulty}>{difficultyLabels[difficulty]}</option>)}
                </select>
              )}
              <button type="button" className="button-primary mt-4" disabled={submitting} onClick={() => void createRoom(game)}>{submitting ? "Creando sala…" : "Crear sala"}</button>
            </div>
          ))}
        </div>
      )}
    </Layout>
  );

  if (step === "join-code") return (
    <Layout title="Unirse a una sala" description="Escribe el código de 6 caracteres que ves en la pantalla del anfitrión." error={error} onBack={() => setStep("menu")}>
      <form className="mx-auto max-w-md" onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!/^[A-Z0-9]{6}$/.test(roomCode)) return setError("El código tiene 6 letras o números.");
        setError(null);
        setStep("join-player");
      }}>
        <label htmlFor="room-code" className="block text-lg font-black text-slate-900">Código de sala</label>
        <input id="room-code" value={roomCode} maxLength={6} autoComplete="off" autoCapitalize="characters" onChange={(event) => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} className="mt-2 min-h-16 w-full rounded-2xl border-2 border-violet-200 bg-white px-4 text-center text-3xl font-black tracking-[0.4em] outline-none focus-visible:ring-4 focus-visible:ring-violet-300" />
        <button type="submit" className="button-primary mt-6 w-full">Continuar</button>
      </form>
    </Layout>
  );

  return (
    <Layout title="Multijugador" description="Jueguen juntos, cada quien desde su dispositivo." error={error} onBack={onExit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <button type="button" className="selection-card" onClick={() => { setError(null); setStep("create-player"); }}>
          <span className="text-6xl" aria-hidden="true">🏠</span>
          <span className="mt-3 block text-2xl font-black text-slate-900">Crear sala</span>
          <span className="mt-2 block text-base text-slate-600">Elige un juego e invita a tu familia.</span>
        </button>
        <button type="button" className="selection-card" onClick={() => { setError(null); setStep("join-code"); }}>
          <span className="text-6xl" aria-hidden="true">🔑</span>
          <span className="mt-3 block text-2xl font-black text-slate-900">Unirse a una sala</span>
          <span className="mt-2 block text-base text-slate-600">Usa el código del anfitrión.</span>
        </button>
      </div>
    </Layout>
  );
}

function useMultiplayerRoom(session: StoredMultiplayerSession) {
  const [state, dispatch] = useReducer(
    (current: typeof initialMultiplayerViewState, action: { event: MultiplayerServerEvent; now: number }) => applyServerEvent(current, action.event, action.now),
    initialMultiplayerViewState,
  );
  const [status, setStatus] = useState<MultiplayerConnectionStatus>("connecting");
  const clientRef = useRef<MultiplayerSocketClient | null>(null);
  const url = readMultiplayerSocketUrl();
  const { roomCode, playerId, participantToken } = session;

  useEffect(() => {
    if (!url) return;
    const client = new MultiplayerSocketClient({
      url,
      identity: { roomCode, playerId, participantToken },
      onEvent: (event) => dispatch({ event, now: Date.now() }),
      onStatus: setStatus,
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [url, roomCode, playerId, participantToken]);

  // Coming back to the tab: ask for the authoritative snapshot instead of trusting local state.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") clientRef.current?.send("SYNC_ROOM"); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const send = useCallback(
    (action: Exclude<MultiplayerClientAction, "IDENTIFY">, payload?: Record<string, unknown>) => clientRef.current?.send(action, payload) ?? null,
    [],
  );
  const stop = useCallback(() => clientRef.current?.close(), []);
  return { state, status, send, configured: Boolean(url), stop };
}

function MultiplayerRoomView({ session, onLeave }: { session: StoredMultiplayerSession; onLeave: () => void }) {
  const { state, status, send, configured, stop } = useMultiplayerRoom(session);
  const [now, setNow] = useState(() => Date.now());
  const [pendingAnswer, setPendingAnswer] = useState<{ questionId: string; answerId: string } | null>(null);
  const timeoutSentRef = useRef<{ questionId: string; at: number } | null>(null);
  const { room, self } = state;
  const question = room?.currentQuestion;
  const terminal = state.error !== null && isTerminalMultiplayerError(state.error.code);

  useEffect(() => { if (terminal) stop(); }, [terminal, stop]);

  const open = room?.status === "IN_PROGRESS" && room.questionState === "OPEN";
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [open]);

  const secondsLeft = remainingSeconds(room, state.clockOffsetMs, now);
  // Automatic (no click): the countdown only *triggers* QUESTION_TIMEOUT; the server re-checks its own deadline.
  useEffect(() => {
    const questionId = questionTimeoutToSend(room, state.clockOffsetMs, now, timeoutSentRef.current);
    if (questionId && send("QUESTION_TIMEOUT", { questionId })) timeoutSentRef.current = { questionId, at: now };
  }, [room, state.clockOffsetMs, now, send]);

  if (!configured) return <Notice title="Multijugador no configurado" description="Define NEXT_PUBLIC_MULTIPLAYER_WEBSOCKET_URL para jugar en línea." onLeave={onLeave} />;
  if (terminal) return <Notice title="No puedes continuar en esta sala" description={multiplayerErrorMessage(state.error, state.error?.message ?? "")} onLeave={onLeave} />;
  if (!room || !self) return <Notice title="Conectando con la sala…" description={status === "reconnecting" ? "Reintentando la conexión." : `Sala ${session.roomCode}`} busy onLeave={onLeave} />;

  const isHost = self.role === "HOST";
  const errorText = state.error ? multiplayerErrorMessage(state.error, "") : "";
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm font-bold text-slate-600 sm:text-base">
      <span>Sala <strong className="tracking-widest text-violet-800">{room.roomCode}</strong> · {room.gameTitle}</span>
      <ConnectionBadge status={status} />
    </div>
  );

  if (room.status === "FINISHED") {
    const podium = state.podium ?? room.scoreboard;
    const winners = podium.filter((entry) => entry.rank === 1);
    return (
      <Shell onLeave={onLeave} leaveLabel="Salir de la sala">
        {header}
        <div className="mt-6 text-center">
          <span className="text-7xl" aria-hidden="true">🏆</span>
          <h1 className="mt-4 text-3xl font-black text-slate-900 sm:text-5xl">{winners.length > 1 ? `¡Empate! ${winners.map((entry) => entry.displayName).join(" y ")}` : `¡Ganó ${winners[0]?.displayName ?? ""}!`}</h1>
        </div>
        <Podium entries={podium} selfId={self.playerId} />
      </Shell>
    );
  }

  if (room.status === "WAITING") {
    const enoughPlayers = room.members.length >= 2;
    return (
      <Shell onLeave={onLeave} leaveLabel="Salir de la sala">
        {header}
        <div className="mt-6 text-center">
          <p className="text-lg font-bold text-slate-600">Código de sala</p>
          <p className="mt-2 text-5xl font-black tracking-[0.3em] text-violet-800 sm:text-6xl" aria-label={`Código ${room.roomCode.split("").join(" ")}`}>{room.roomCode}</p>
        </div>
        <h2 className="mt-8 text-xl font-black text-slate-900">Jugadores ({room.members.length})</h2>
        <ul className="mt-3 grid gap-2">
          {room.members.map((member) => (
            <li key={member.playerId} className="flex items-center justify-between rounded-2xl bg-violet-50 px-4 py-3 text-lg font-bold text-slate-900">
              <span>{member.displayName}{member.playerId === self.playerId ? " (tú)" : ""}</span>
              <span className="flex items-center gap-3 text-sm">
                {member.role === "HOST" && <span className="rounded-full bg-amber-200 px-3 py-1 text-amber-900">Anfitrión</span>}
                <span className={member.connected ? "text-emerald-700" : "text-slate-500"}>{member.connected ? "● Conectado" : "○ Desconectado"}</span>
              </span>
            </li>
          ))}
        </ul>
        {errorText && <p className="mt-6 rounded-2xl bg-rose-100 p-4 text-center font-bold text-rose-900" role="alert">{errorText}</p>}
        {isHost
          ? <button type="button" className="button-primary mt-8 w-full" disabled={!enoughPlayers || status !== "connected"} onClick={() => send("START_GAME")}>{enoughPlayers ? "Empezar partida" : "Esperando a otro jugador…"}</button>
          : <p className="mt-8 text-center text-lg font-bold text-slate-600" aria-live="polite">Esperando a que el anfitrión empiece…</p>}
      </Shell>
    );
  }

  if (!question) return <Notice title="Sincronizando…" description="Esperando la pregunta actual." busy onLeave={onLeave} />;

  const revealed = room.questionState === "REVEALED" && room.reveal?.questionId === question.id ? room.reveal : undefined;
  const myAnswerId = state.answeredQuestionId === question.id ? state.myAnswerId : pendingAnswer?.questionId === question.id ? pendingAnswer.answerId : null;
  const myResult = revealed?.results.find((result) => result.playerId === self.playerId);

  function answer(answerId: string) {
    if (!question || myAnswerId || revealed) return;
    if (send("SUBMIT_ANSWER", { questionId: question.id, answerId })) setPendingAnswer({ questionId: question.id, answerId });
  }

  return (
    <Shell onLeave={onLeave} leaveLabel="Salir de la sala">
      {header}
      <div className="mt-4 flex items-center justify-between gap-4 text-sm font-bold text-slate-600 sm:text-base">
        <span>Pregunta {room.questionNumber} de {room.totalQuestions}</span>
        {secondsLeft !== null && <span className={`rounded-full px-3 py-1 text-lg ${secondsLeft <= 5 ? "bg-rose-100 text-rose-800" : "bg-violet-100 text-violet-800"}`} aria-live="off">⏱ {secondsLeft}s</span>}
        <span>{room.answeredPlayerIds.length}/{room.members.length} respondieron</span>
      </div>
      {question.emoji && <span className="mb-2 mt-6 block text-center text-7xl" aria-hidden="true">{question.emoji}</span>}
      {question.media?.image && <QuestionImageView key={question.id} image={question.media.image} />}
      <h1 className="mt-6 text-2xl font-black leading-tight text-slate-900 sm:text-4xl">{question.text}</h1>
      <QuestionAudioButton gameId={room.gameId} questionId={question.id} />
      <fieldset aria-label="Opciones"><div className="mt-6 grid gap-3 sm:grid-cols-2">{question.answers.map((option) => {
        const mine = myAnswerId === option.id;
        let stateClass = "border-slate-200 bg-white hover:border-violet-400 hover:bg-violet-50";
        if (revealed?.correctAnswerId === option.id) stateClass = "border-emerald-500 bg-emerald-50 text-emerald-900";
        else if (revealed && mine) stateClass = "border-rose-500 bg-rose-50 text-rose-900";
        else if (mine) stateClass = "border-violet-600 bg-violet-100 text-violet-900";
        return <button key={option.id} type="button" disabled={Boolean(myAnswerId) || Boolean(revealed) || status !== "connected"} aria-pressed={mine} onClick={() => answer(option.id)} className={`min-h-16 rounded-2xl border-2 px-5 py-4 text-left text-lg font-bold shadow-sm outline-none transition focus-visible:ring-4 focus-visible:ring-violet-300 disabled:cursor-default disabled:opacity-100 ${stateClass}`}>{option.text}</button>;
      })}</div></fieldset>
      <div className="mt-6 min-h-16" aria-live="polite">
        {revealed
          ? <p className={`rounded-2xl p-4 text-lg font-bold ${myResult?.isCorrect ? "bg-emerald-100 text-emerald-900" : "bg-slate-100 text-slate-800"}`}>{myResult?.isCorrect ? `¡Correcto! +${myResult.pointsAwarded} puntos${myResult.placement && myResult.placement <= 3 ? ` (${myResult.placement}.º en acertar)` : ""}` : myResult?.answered ? "Esta vez no. +0 puntos" : "Sin respuesta. +0 puntos"}</p>
          : myAnswerId ? <p className="rounded-2xl bg-violet-50 p-4 text-lg font-bold text-violet-900">Respuesta enviada 🔒 Esperando a los demás…</p> : null}
        {errorText && <p className="mt-3 rounded-2xl bg-rose-100 p-4 font-bold text-rose-900" role="alert">{errorText}</p>}
      </div>
      {revealed && isHost && <button type="button" className="button-primary mt-2 w-full" disabled={status !== "connected"} onClick={() => send("NEXT_QUESTION")}>Siguiente pregunta</button>}
      {revealed && !isHost && <p className="mt-2 text-center font-bold text-slate-600">El anfitrión abrirá la siguiente pregunta.</p>}
      <h2 className="mt-8 text-xl font-black text-slate-900">Marcador</h2>
      <Scoreboard entries={room.scoreboard} selfId={self.playerId} />
    </Shell>
  );
}

function Podium({ entries, selfId }: { entries: ScoreboardEntry[]; selfId: string }) {
  return (
    <>
      <ol className="mt-8 grid gap-3 sm:grid-cols-3">
        {entries.filter((entry) => entry.rank <= 3).map((entry) => (
          <li key={entry.playerId} className={`rounded-3xl p-5 text-center ${entry.rank === 1 ? "bg-amber-100" : "bg-violet-50"}`}>
            <span className="text-5xl" aria-hidden="true">{medals[entry.rank - 1]}</span>
            <p className="mt-2 text-2xl font-black text-slate-900">{entry.displayName}{entry.playerId === selfId ? " (tú)" : ""}</p>
            <p className="mt-1 font-bold text-slate-700">{entry.rank}.º lugar · {entry.totalPoints} puntos</p>
            <p className="text-slate-600">{entry.correctAnswers} respuestas correctas</p>
          </li>
        ))}
      </ol>
      <Scoreboard entries={entries} selfId={selfId} />
    </>
  );
}

function Scoreboard({ entries, selfId }: { entries: ScoreboardEntry[]; selfId: string }) {
  return (
    <ol className="mt-3 grid gap-2">
      {entries.map((entry) => (
        <li key={entry.playerId} className={`flex items-center justify-between rounded-2xl px-4 py-3 font-bold ${entry.playerId === selfId ? "bg-violet-100 text-violet-900" : "bg-slate-50 text-slate-800"}`}>
          <span>{entry.rank <= 3 ? `${medals[entry.rank - 1]} ` : `${entry.rank}. `}{entry.displayName}</span>
          <span>{entry.totalPoints} pts · {entry.correctAnswers} ✓</span>
        </li>
      ))}
    </ol>
  );
}

function ConnectionBadge({ status }: { status: MultiplayerConnectionStatus }) {
  const label = status === "connected" ? "● En línea" : status === "closed" ? "○ Desconectado" : "◌ Reconectando…";
  return <span className={status === "connected" ? "text-emerald-700" : "text-amber-700"} role="status">{label}</span>;
}

function PlayerPicker({ players, disabled, onChoose }: { players: Player[] | null; disabled: boolean; onChoose: (player: Player) => void }) {
  if (!players || players.length === 0) return <p className="text-center text-lg text-slate-600">Primero crea un perfil familiar desde “Comenzar”.</p>;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {players.map((player) => (
        <button key={player.playerId} type="button" disabled={disabled} onClick={() => onChoose(player)} className="selection-card disabled:cursor-wait disabled:opacity-60">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-violet-100 text-3xl font-black text-violet-700" aria-hidden="true">{player.name.charAt(0).toUpperCase()}</span>
          <span className="mt-3 text-2xl font-black text-slate-900">{player.name}</span>
        </button>
      ))}
    </div>
  );
}

function Layout({ title, description, error, onBack, children }: { title: string; description: string; error: string | null; onBack: () => void; children: ReactNode }) {
  return (
    <main className="page-shell py-8 sm:py-14"><div className="mx-auto w-full max-w-5xl">
      <button type="button" onClick={onBack} className="inline-flex min-h-11 items-center rounded-xl px-2 font-bold text-violet-800 outline-none hover:bg-white/70 focus-visible:ring-4 focus-visible:ring-violet-300">← Volver</button>
      <section className="card mt-4">
        <header className="mb-8 text-center">
          <p className="font-black text-violet-700">Multijugador</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-900 sm:text-5xl">{title}</h1>
          <p className="mx-auto mt-3 max-w-2xl text-lg text-slate-600 sm:text-xl">{description}</p>
        </header>
        {error && <p className="mb-6 rounded-2xl bg-rose-100 p-4 text-center font-bold text-rose-900" role="alert">{error}</p>}
        {children}
      </section>
    </div></main>
  );
}

function Shell({ onLeave, leaveLabel, children }: { onLeave: () => void; leaveLabel: string; children: ReactNode }) {
  return (
    <main className="page-shell py-8 sm:py-12"><div className="mx-auto w-full max-w-3xl">
      <button type="button" onClick={onLeave} className="inline-flex min-h-11 items-center rounded-xl px-2 font-bold text-violet-800 outline-none hover:bg-white/70 focus-visible:ring-4 focus-visible:ring-violet-300">← {leaveLabel}</button>
      <section className="card mt-4">{children}</section>
    </div></main>
  );
}

function Notice({ title, description, busy = false, onLeave }: { title: string; description: string; busy?: boolean; onLeave: () => void }) {
  return (
    <Shell onLeave={onLeave} leaveLabel="Salir">
      <div className="text-center" aria-live="polite" aria-busy={busy}>
        <span className="text-7xl" aria-hidden="true">{busy ? "⏳" : "🧩"}</span>
        <h1 className="mt-5 text-3xl font-black text-slate-900">{title}</h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-slate-700">{description}</p>
      </div>
    </Shell>
  );
}
