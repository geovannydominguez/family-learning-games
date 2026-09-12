"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type { AnswerFeedback, GameSetupResponse, PublicGame, PublicGameSession } from "@/application/game/gameSessionContracts";
import type { Category, Difficulty } from "@/domain/game/types";
import type { Player } from "@/domain/player/types";
import { createGameApiClient } from "@/infrastructure/http/GameApiClient";
import { buildStartSessionCommand, createdGameDifficulty, gameUiErrorMessage, selectCreatedGames } from "./gameUiState";

interface PlayerFormState {
  open: boolean;
  mode: "create" | "edit";
  playerId?: string;
  name: string;
  age: string;
}

const closedPlayerForm: PlayerFormState = { open: false, mode: "create", name: "", age: "" };

type FlowStep = "home" | "player" | "category" | "difficulty" | "generate" | "game";

const difficultyOptions: Array<{ id: Difficulty; label: string; icon: string; description: string }> = [
  { id: "easy", label: "Fácil", icon: "🌱", description: "Para empezar con calma" },
  { id: "normal", label: "Normal", icon: "⭐", description: "Un desafío equilibrado" },
  { id: "hard", label: "Difícil", icon: "🚀", description: "Para grandes exploradores" },
];

const difficultyLabel = (id: Difficulty): string =>
  difficultyOptions.find((option) => option.id === id)?.label ?? id;

export function QuizGame() {
  const [setup, setSetup] = useState<GameSetupResponse | null>(null);
  const [step, setStep] = useState<FlowStep>("home");
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [loadingPlayers, setLoadingPlayers] = useState(true);
  const [playerForm, setPlayerForm] = useState<PlayerFormState>(closedPlayerForm);
  const [submittingPlayer, setSubmittingPlayer] = useState(false);
  const [pendingDeletePlayerId, setPendingDeletePlayerId] = useState<string | null>(null);
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [selectedGameId, setSelectedGameId] = useState<string | undefined>();
  const [generationTopic, setGenerationTopic] = useState("");
  const [generationDifficulty, setGenerationDifficulty] = useState<Difficulty>("easy");
  const [generatedGame, setGeneratedGame] = useState<PublicGame | null>(null);
  const [session, setSession] = useState<PublicGameSession | null>(null);
  const [feedback, setFeedback] = useState<AnswerFeedback | null>(null);
  const [pendingSession, setPendingSession] = useState<PublicGameSession | null>(null);
  const [createdGames, setCreatedGames] = useState<PublicGame[] | null>(null);
  const [createdGamesFailed, setCreatedGamesFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingSetup, setLoadingSetup] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const loadSetup = useCallback(async () => {
    setLoadingSetup(true);
    setError(null);
    try {
      setSetup(await createGameApiClient().getSetup());
    } catch (caught) {
      setSetup(null);
      setError(gameUiErrorMessage(caught, "No pudimos preparar el juego."));
    } finally {
      setLoadingSetup(false);
    }
  }, []);

  const loadCreatedGames = useCallback(async () => {
    try {
      setCreatedGames(await createGameApiClient().listGames());
      setCreatedGamesFailed(false);
    } catch {
      // "Tus juegos creados" is optional: never block the base categories.
      setCreatedGamesFailed(true);
    }
  }, []);

  const loadPlayers = useCallback(async () => {
    setLoadingPlayers(true);
    try {
      setPlayers(await createGameApiClient().listPlayers());
    } catch (caught) {
      setPlayers(null);
      setError(gameUiErrorMessage(caught, "No pudimos cargar los jugadores."));
    } finally {
      setLoadingPlayers(false);
    }
  }, []);

  useEffect(() => { void loadSetup(); }, [loadSetup]);
  useEffect(() => { void loadPlayers(); }, [loadPlayers]);
  useEffect(() => {
    if (step === "category") void loadCreatedGames();
  }, [step, loadCreatedGames]);
  useEffect(() => {
    if (step !== "home") headingRef.current?.focus();
  }, [session?.currentQuestionIndex, session?.status, step]);

  function choosePlayer(playerId: string) {
    const player = players?.find((candidate) => candidate.playerId === playerId);
    if (!player) return setError("No pudimos encontrar ese jugador. Elige uno de la lista.");
    setSelectedPlayer(player);
    setSelectedCategory(null);
    setSelectedGameId(undefined);
    setGeneratedGame(null);
    setSession(null);
    setError(null);
    setStep("category");
  }

  function openCreatePlayerForm() {
    setError(null);
    setPlayerForm({ open: true, mode: "create", name: "", age: "" });
  }

  function openEditPlayerForm(player: Player) {
    setError(null);
    setPlayerForm({ open: true, mode: "edit", playerId: player.playerId, name: player.name, age: String(player.age) });
  }

  function closePlayerForm() {
    setPlayerForm(closedPlayerForm);
  }

  async function submitPlayerForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = playerForm.name.trim();
    const age = Number(playerForm.age);
    if (!name || name.length > 50 || !Number.isInteger(age) || age < 3 || age > 99) {
      setError("Escribe un nombre de hasta 50 caracteres y una edad entre 3 y 99 años.");
      return;
    }
    setSubmittingPlayer(true);
    setError(null);
    try {
      if (playerForm.mode === "edit" && playerForm.playerId) {
        await createGameApiClient().updatePlayer(playerForm.playerId, { name, age });
      } else {
        await createGameApiClient().createPlayer({ name, age });
      }
      closePlayerForm();
      await loadPlayers();
    } catch (caught) {
      setError(gameUiErrorMessage(caught, "No pudimos guardar el jugador."));
    } finally {
      setSubmittingPlayer(false);
    }
  }

  async function removePlayer(playerId: string) {
    setSubmittingPlayer(true);
    setError(null);
    try {
      await createGameApiClient().deletePlayer(playerId);
      setPendingDeletePlayerId(null);
      if (selectedPlayer?.playerId === playerId) {
        setSelectedPlayer(null);
        setStep("player");
      }
      await loadPlayers();
    } catch (caught) {
      setError(gameUiErrorMessage(caught, "No pudimos eliminar el jugador."));
    } finally {
      setSubmittingPlayer(false);
    }
  }

  function chooseCategory(categoryId: string) {
    const category = setup?.categories.find((candidate) => candidate.id === categoryId);
    if (!category || !selectedPlayer) {
      setError("La selección no es válida. Vuelve a elegir jugador y categoría.");
      return setStep(selectedPlayer ? "category" : "player");
    }
    setSelectedCategory(category);
    setSelectedGameId(undefined);
    setGeneratedGame(null);
    setSession(null);
    setError(null);
    setStep("difficulty");
  }

  async function startGame(difficulty: Difficulty, gameId = selectedGameId, category = selectedCategory) {
    if (!selectedPlayer || !category) return;
    setSubmitting(true);
    setError(null);
    try {
      const started = await createGameApiClient().startSession(buildStartSessionCommand(
        selectedPlayer.playerId,
        category.id,
        difficulty,
        gameId,
      ));
      setSession(started);
      setFeedback(null);
      setPendingSession(null);
      setStep("game");
    } catch (caught) {
      setError(gameUiErrorMessage(caught, "No pudimos iniciar la partida."));
    } finally {
      setSubmitting(false);
    }
  }

  async function startCreatedGame(game: PublicGame) {
    if (!selectedPlayer) {
      setError("Elige un jugador antes de jugar.");
      setStep("player");
      return;
    }
    setSelectedCategory(game.category);
    setSelectedGameId(game.id);
    setError(null);
    await startGame(createdGameDifficulty(game), game.id, game.category);
  }

  async function generateGame(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedPlayer) {
      setError("Elige un jugador antes de crear un juego.");
      setStep("player");
      return;
    }
    const topic = generationTopic.trim();
    if (!topic) {
      setError("Escribe un tema válido de hasta 80 caracteres y elige una dificultad.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setGeneratedGame(null);
    try {
      const game = await createGameApiClient().generateGame({
        topic,
        difficulty: generationDifficulty,
        questionCount: 10,
        playerId: selectedPlayer.playerId,
      });
      setGeneratedGame(game);
      setSelectedCategory(game.category);
      setSelectedGameId(game.id);
      void loadCreatedGames();
    } catch (caught) {
      setError(gameUiErrorMessage(caught, "No pudimos crear el juego."));
    } finally {
      setSubmitting(false);
    }
  }

  async function answer(answerId: string) {
    if (!session || feedback || submitting) return;
    setSubmitting(true);
    setAnsweringId(answerId);
    setError(null);
    try {
      const result = await createGameApiClient().answerSession(session.id, answerId);
      setFeedback(result.feedback);
      setPendingSession(result.nextSession);
    } catch (caught) {
      setError(gameUiErrorMessage(caught, "No pudimos guardar tu respuesta. Inténtalo otra vez."));
    } finally {
      setSubmitting(false);
      setAnsweringId(null);
    }
  }

  function nextQuestion() {
    if (!pendingSession) return;
    setSession(pendingSession);
    setPendingSession(null);
    setFeedback(null);
    setError(null);
  }

  function chooseAnotherGame() {
    setSelectedCategory(null);
    setSelectedGameId(undefined);
    setGeneratedGame(null);
    setGenerationTopic("");
    setSession(null);
    setFeedback(null);
    setPendingSession(null);
    setError(null);
    setStep(selectedPlayer ? "category" : "player");
  }

  if (loadingSetup) return <StatusCard title="Preparando el juego…" description="Estamos buscando las preguntas para tu familia." busy />;
  if (!setup) return <StatusCard title="No pudimos cargar el juego" description={error ?? "Inténtalo otra vez."} actionLabel="Reintentar" onAction={() => void loadSetup()} />;

  if (step === "home") {
    return (
      <main className="page-shell flex items-center justify-center py-12 sm:py-20">
        <section className="card w-full max-w-4xl text-center" aria-labelledby="welcome-title">
          <span className="text-7xl" aria-hidden="true">🎲</span>
          <h1 id="welcome-title" className="mt-5 text-4xl font-black tracking-tight text-slate-900 sm:text-6xl">Family Learning Games</h1>
          <p className="mx-auto mt-5 max-w-2xl text-xl leading-relaxed text-slate-700 sm:text-2xl">Aprendamos, juguemos y descubramos cosas nuevas en familia.</p>
          <button className="button-primary mt-9 min-w-56" onClick={() => setStep("player")} type="button">Comenzar</button>
        </section>
      </main>
    );
  }

  if (step === "player") return (
    <SelectionLayout headingRef={headingRef} eyebrow="Paso 1 de 3" title="¿Quién va a jugar?" description="Elige un perfil familiar o crea uno nuevo." error={error} onBack={() => setStep("home")}>
      <PlayerProfilesPanel
        players={players}
        loading={loadingPlayers}
        submitting={submittingPlayer}
        form={playerForm}
        pendingDeleteId={pendingDeletePlayerId}
        onChoose={choosePlayer}
        onEdit={openEditPlayerForm}
        onRequestDelete={setPendingDeletePlayerId}
        onCancelDelete={() => setPendingDeletePlayerId(null)}
        onConfirmDelete={(playerId) => void removePlayer(playerId)}
        onOpenCreate={openCreatePlayerForm}
        onCancelForm={closePlayerForm}
        onFormChange={setPlayerForm}
        onSubmitForm={(event) => void submitPlayerForm(event)}
      />
    </SelectionLayout>
  );

  if (step === "category") return (
    <SelectionLayout headingRef={headingRef} eyebrow={`Jugando como ${selectedPlayer?.name ?? "familia"}`} title="¿Qué quieres aprender?" description="Elige una categoría para tu próxima partida." error={error} onBack={() => setStep("player")}>
      <div className="grid gap-4 sm:grid-cols-3">{setup.categories.map((category) => <button key={category.id} type="button" onClick={() => chooseCategory(category.id)} className="selection-card text-left"><span className="text-6xl" aria-hidden="true">{category.icon}</span><span className="mt-3 block text-2xl font-black text-slate-900">{category.name}</span><span className="mt-2 block text-base leading-relaxed text-slate-600">{category.description}</span></button>)}</div>
      <CreatedGamesSection games={createdGames} failed={createdGamesFailed} disabled={submitting} onPlay={(game) => void startCreatedGame(game)} />
      <div className="mt-8 border-t border-violet-100 pt-8 text-center"><p className="text-lg text-slate-700">¿Quieres explorar otro tema?</p><button type="button" className="button-secondary mt-4" onClick={() => { setError(null); setGeneratedGame(null); setStep("generate"); }}>✨ Crear un juego nuevo</button></div>
    </SelectionLayout>
  );

  if (step === "generate") return (
    <SelectionLayout headingRef={headingRef} eyebrow={`Jugando como ${selectedPlayer?.name ?? "familia"}`} title="Crea un juego nuevo" description="Elige un tema y una dificultad. El juego tendrá exactamente 10 preguntas." error={error} onBack={() => setStep("category")}>
      <form className="mx-auto max-w-2xl" onSubmit={(event) => void generateGame(event)}>
        <label htmlFor="generation-topic" className="block text-lg font-black text-slate-900">Tema del juego</label>
        <input id="generation-topic" type="text" required maxLength={80} value={generationTopic} disabled={submitting} onChange={(event) => { setGenerationTopic(event.target.value); setGeneratedGame(null); }} placeholder="Por ejemplo: dinosaurios" className="mt-2 min-h-14 w-full rounded-2xl border-2 border-violet-200 bg-white px-4 text-lg outline-none focus-visible:ring-4 focus-visible:ring-violet-300 disabled:opacity-60" />
        <label htmlFor="generation-difficulty" className="mt-6 block text-lg font-black text-slate-900">Dificultad</label>
        <select id="generation-difficulty" value={generationDifficulty} disabled={submitting} onChange={(event) => { setGenerationDifficulty(event.target.value as Difficulty); setGeneratedGame(null); }} className="mt-2 min-h-14 w-full rounded-2xl border-2 border-violet-200 bg-white px-4 text-lg font-bold outline-none focus-visible:ring-4 focus-visible:ring-violet-300 disabled:opacity-60">
          {difficultyOptions.filter((option) => setup.difficulties.includes(option.id)).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <button className="button-primary mt-7 w-full" type="submit" disabled={submitting}>{submitting ? "Creando juego…" : "Crear juego"}</button>
      </form>
      {generatedGame && <section className="mx-auto mt-8 max-w-2xl rounded-3xl bg-emerald-50 p-6 text-center" aria-live="polite"><span className="text-5xl" aria-hidden="true">{generatedGame.category.icon || "✨"}</span><h2 className="mt-3 text-2xl font-black text-slate-900">{generatedGame.title}</h2><p className="mt-2 text-slate-700">Tu juego está listo.</p><button type="button" className="button-primary mt-5" disabled={submitting} onClick={() => void startGame(generationDifficulty, generatedGame.id)}>{submitting ? "Iniciando…" : "Jugar ahora"}</button></section>}
    </SelectionLayout>
  );

  if (step === "difficulty") return (
    <SelectionLayout headingRef={headingRef} eyebrow={`${selectedPlayer?.name ?? ""} · ${selectedCategory?.icon ?? ""} ${selectedCategory?.name ?? ""}`} title="Elige la dificultad" description="La partida tendrá exactamente 10 preguntas." error={error} onBack={() => setStep("category")}>
      <div className="grid gap-4 sm:grid-cols-3">{difficultyOptions.filter((option) => setup.difficulties.includes(option.id)).map((difficulty) => <button key={difficulty.id} type="button" disabled={submitting} onClick={() => void startGame(difficulty.id)} className="selection-card disabled:cursor-wait disabled:opacity-60"><span className="text-6xl" aria-hidden="true">{difficulty.icon}</span><span className="mt-3 block text-2xl font-black text-slate-900">{difficulty.label}</span><span className="mt-2 block text-base text-slate-600">{submitting ? "Iniciando…" : difficulty.description}</span></button>)}</div>
    </SelectionLayout>
  );

  if (!session) return <SelectionLayout headingRef={headingRef} title="No pudimos abrir la partida" description="Vuelve a elegir una categoría para intentarlo otra vez." error={error} onBack={chooseAnotherGame} />;

  if (session.status === "completed") {
    const perfectScore = session.score === session.totalQuestions;
    return (
      <main className="page-shell flex items-center justify-center py-10 sm:py-16"><section className="card w-full max-w-2xl text-center" aria-labelledby="result-title">
        <span className="mb-4 block text-7xl" aria-hidden="true">{perfectScore ? "🏆" : "🎉"}</span>
        <h1 ref={headingRef} id="result-title" tabIndex={-1} className="text-3xl font-black tracking-tight text-slate-900 outline-none sm:text-5xl">{perfectScore ? `¡Excelente, ${session.player.name}!` : `¡Muy bien, ${session.player.name}!`}</h1>
        <p className="mt-5 text-xl text-slate-700 sm:text-2xl">Acertaste <strong className="text-violet-700">{session.score}</strong> de <strong>{session.totalQuestions}</strong> preguntas.</p>
        <p className="mt-3 text-lg text-slate-600">{perfectScore ? "Tu curiosidad llegó muy lejos." : "Cada intento nos ayuda a aprender."}</p>
        {error && <p className="mt-5 rounded-2xl bg-rose-100 p-4 font-bold text-rose-900" role="alert">{error}</p>}
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row"><button className="button-primary" disabled={submitting} onClick={() => void startGame(session.difficulty)} type="button">{submitting ? "Iniciando…" : "Jugar nuevamente"}</button><button className="button-secondary" disabled={submitting} onClick={chooseAnotherGame} type="button">Elegir otro juego</button></div>
      </section></main>
    );
  }

  const question = session.currentQuestion;
  if (!question) return <SelectionLayout headingRef={headingRef} title="No encontramos la pregunta" description="La partida no puede continuar con estos datos." error="Elige otra categoría para iniciar una partida nueva." onBack={chooseAnotherGame} />;
  const progress = ((session.currentQuestionIndex + 1) / session.totalQuestions) * 100;
  const displayedScore = pendingSession?.score ?? session.score;

  return (
    <main className="page-shell py-8 sm:py-12"><div className="mx-auto w-full max-w-3xl">
      <button type="button" onClick={chooseAnotherGame} disabled={submitting} className="inline-flex min-h-11 items-center rounded-xl px-2 font-bold text-violet-800 outline-none hover:bg-white/70 focus-visible:ring-4 focus-visible:ring-violet-300">← Elegir otro juego</button>
      <section className="card mt-4" aria-labelledby="question-title">
        <p className="mb-4 font-bold text-violet-800">{session.player.avatar} {session.player.name} · {session.category.icon} {session.category.name}</p>
        <div className="flex items-center justify-between gap-4 text-sm font-bold text-slate-600 sm:text-base"><span>Pregunta {session.currentQuestionIndex + 1} de {session.totalQuestions}</span><span aria-label={`${displayedScore} respuestas correctas`}>⭐ {displayedScore} puntos</span></div>
        <div className="mt-3 h-3 overflow-hidden rounded-full bg-violet-100" role="progressbar" aria-label="Progreso de la partida" aria-valuemin={1} aria-valuemax={session.totalQuestions} aria-valuenow={session.currentQuestionIndex + 1}><div className="h-full rounded-full bg-violet-600 transition-all" style={{ width: `${progress}%` }} /></div>
        {question.emoji && <span className="mb-4 mt-8 block text-center text-7xl" aria-hidden="true">{question.emoji}</span>}
        <h1 ref={headingRef} id="question-title" tabIndex={-1} className="mt-8 text-2xl font-black leading-tight text-slate-900 outline-none sm:text-4xl">{question.text}</h1>
        <fieldset aria-labelledby="question-title"><div className="mt-7 grid gap-3 sm:grid-cols-2">{question.answers.map((answerOption) => {
          const selected = feedback?.selectedAnswerId === answerOption.id;
          let stateClass = "border-slate-200 bg-white hover:border-violet-400 hover:bg-violet-50";
          if (feedback?.correctAnswerId === answerOption.id) stateClass = "border-emerald-500 bg-emerald-50 text-emerald-900";
          else if (feedback && selected) stateClass = "border-rose-500 bg-rose-50 text-rose-900";
          return <button key={answerOption.id} type="button" disabled={Boolean(feedback) || submitting} aria-pressed={selected} onClick={() => void answer(answerOption.id)} className={`min-h-16 rounded-2xl border-2 px-5 py-4 text-left text-lg font-bold shadow-sm outline-none transition focus-visible:ring-4 focus-visible:ring-violet-300 disabled:cursor-default disabled:opacity-100 ${stateClass}`}>{answeringId === answerOption.id ? "Enviando respuesta…" : answerOption.text}</button>;
        })}</div></fieldset>
        <div className="mt-7 min-h-24" aria-live="polite">{error && <div className="rounded-2xl bg-rose-100 p-4 text-lg font-bold text-rose-900" role="alert">{error}</div>}{feedback && <div className={`rounded-2xl p-4 text-lg font-bold ${feedback.isCorrect ? "bg-emerald-100 text-emerald-900" : "bg-rose-100 text-rose-900"}`}>{feedback.isCorrect ? "¡Correcto! Muy buen trabajo." : `Casi. La respuesta correcta es ${feedback.correctAnswerText}.`}</div>}</div>
        <button type="button" onClick={nextQuestion} disabled={!pendingSession || submitting} className="button-primary mt-2 w-full disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500">{session.currentQuestionIndex === session.totalQuestions - 1 ? "Ver resultado" : "Siguiente pregunta"}</button>
      </section>
    </div></main>
  );
}

interface PlayerProfilesPanelProps {
  players: Player[] | null;
  loading: boolean;
  submitting: boolean;
  form: PlayerFormState;
  pendingDeleteId: string | null;
  onChoose: (playerId: string) => void;
  onEdit: (player: Player) => void;
  onRequestDelete: (playerId: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (playerId: string) => void;
  onOpenCreate: () => void;
  onCancelForm: () => void;
  onFormChange: (updater: (current: PlayerFormState) => PlayerFormState) => void;
  onSubmitForm: (event: FormEvent<HTMLFormElement>) => void;
}

function PlayerProfilesPanel({
  players,
  loading,
  submitting,
  form,
  pendingDeleteId,
  onChoose,
  onEdit,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  onOpenCreate,
  onCancelForm,
  onFormChange,
  onSubmitForm,
}: PlayerProfilesPanelProps) {
  if (loading) return <p className="text-center text-lg text-slate-600">Cargando jugadores…</p>;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        {(players ?? []).map((player) => (
          <div key={player.playerId} className="selection-card items-stretch text-left">
            {pendingDeleteId === player.playerId ? (
              <div className="flex flex-col items-center gap-3 py-2">
                <p className="text-center text-lg font-bold text-slate-900">¿Eliminar a {player.name}?</p>
                <div className="flex gap-3">
                  <button type="button" className="button-secondary" onClick={onCancelDelete}>Cancelar</button>
                  <button type="button" className="button-primary bg-rose-600 hover:bg-rose-700 focus-visible:ring-rose-300" disabled={submitting} onClick={() => onConfirmDelete(player.playerId)}>{submitting ? "Eliminando…" : "Eliminar"}</button>
                </div>
              </div>
            ) : (
              <>
                <button type="button" onClick={() => onChoose(player.playerId)} className="flex w-full flex-col items-center">
                  <span className="flex h-16 w-16 items-center justify-center rounded-full bg-violet-100 text-3xl font-black text-violet-700" aria-hidden="true">{player.name.charAt(0).toUpperCase()}</span>
                  <span className="mt-3 text-2xl font-black text-slate-900">{player.name}</span>
                  <span className="mt-1 text-base text-slate-500">{player.age} años</span>
                </button>
                <div className="mt-4 flex justify-center gap-5 text-base font-bold text-violet-700">
                  <button type="button" className="min-h-11 underline outline-none focus-visible:ring-4 focus-visible:ring-violet-300" onClick={() => onEdit(player)}>Editar</button>
                  <button type="button" className="min-h-11 text-rose-700 underline outline-none focus-visible:ring-4 focus-visible:ring-rose-300" onClick={() => onRequestDelete(player.playerId)}>Eliminar</button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-8 border-t border-violet-100 pt-8">
        {form.open ? (
          <form className="mx-auto max-w-md" onSubmit={onSubmitForm}>
            <h2 className="text-center text-xl font-black text-slate-900">{form.mode === "edit" ? "Editar jugador" : "Nuevo jugador"}</h2>
            <label htmlFor="player-name" className="mt-4 block text-lg font-black text-slate-900">Nombre</label>
            <input id="player-name" type="text" required maxLength={50} value={form.name} disabled={submitting} onChange={(event) => onFormChange((current) => ({ ...current, name: event.target.value }))} className="mt-2 min-h-14 w-full rounded-2xl border-2 border-violet-200 bg-white px-4 text-lg outline-none focus-visible:ring-4 focus-visible:ring-violet-300 disabled:opacity-60" />
            <label htmlFor="player-age" className="mt-4 block text-lg font-black text-slate-900">Edad</label>
            <input id="player-age" type="number" required min={3} max={99} value={form.age} disabled={submitting} onChange={(event) => onFormChange((current) => ({ ...current, age: event.target.value }))} className="mt-2 min-h-14 w-full rounded-2xl border-2 border-violet-200 bg-white px-4 text-lg outline-none focus-visible:ring-4 focus-visible:ring-violet-300 disabled:opacity-60" />
            <div className="mt-6 flex justify-center gap-3">
              <button type="button" className="button-secondary" disabled={submitting} onClick={onCancelForm}>Cancelar</button>
              <button type="submit" className="button-primary" disabled={submitting}>{submitting ? "Guardando…" : "Guardar"}</button>
            </div>
          </form>
        ) : (
          <div className="text-center">
            <button type="button" className="button-secondary" onClick={onOpenCreate}>+ Agregar jugador</button>
          </div>
        )}
      </div>
    </>
  );
}

function CreatedGamesSection({ games, failed, disabled, onPlay }: { games: PublicGame[] | null; failed: boolean; disabled: boolean; onPlay: (game: PublicGame) => void }) {
  const created = selectCreatedGames(games);
  if (created.length === 0) {
    return failed
      ? <p className="mt-8 text-center text-sm text-slate-500" role="status">No pudimos cargar tus juegos creados. Vuelve a intentarlo más tarde.</p>
      : null;
  }
  return (
    <section className="mt-10" aria-labelledby="created-games-title">
      <h2 id="created-games-title" className="text-2xl font-black text-slate-900">Tus juegos creados</h2>
      <p className="mt-1 text-base text-slate-600">Vuelve a jugar los juegos que creaste con IA, sin generarlos otra vez.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {created.map((game) => (
          <button key={game.id} type="button" disabled={disabled} onClick={() => onPlay(game)} className="selection-card text-left disabled:cursor-wait disabled:opacity-60">
            <span className="text-5xl" aria-hidden="true">{game.category.icon || "✨"}</span>
            <span className="mt-3 block text-xl font-black text-slate-900">{game.title}</span>
            <span className="mt-1 block text-sm font-bold text-slate-500">{game.category.name}{game.difficulties[0] ? ` · ${difficultyLabel(game.difficulties[0])}` : ""}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function StatusCard({ title, description, busy = false, actionLabel, onAction }: { title: string; description: string; busy?: boolean; actionLabel?: string; onAction?: () => void }) {
  return <main className="page-shell flex items-center justify-center py-12 sm:py-20"><section className="card w-full max-w-2xl text-center" aria-live="polite" aria-busy={busy}><span className="text-7xl" aria-hidden="true">{busy ? "⏳" : "🧩"}</span><h1 className="mt-5 text-3xl font-black text-slate-900 sm:text-5xl">{title}</h1><p className="mx-auto mt-4 max-w-xl text-lg text-slate-700">{description}</p>{actionLabel && onAction && <button className="button-primary mt-7" type="button" onClick={onAction}>{actionLabel}</button>}</section></main>;
}

interface SelectionLayoutProps { headingRef: React.RefObject<HTMLHeadingElement | null>; eyebrow?: string; title: string; description: string; error?: string | null; onBack: () => void; children?: React.ReactNode; }
function SelectionLayout({ headingRef, eyebrow, title, description, error, onBack, children }: SelectionLayoutProps) {
  return <main className="page-shell py-8 sm:py-14"><div className="mx-auto w-full max-w-5xl"><button type="button" onClick={onBack} className="inline-flex min-h-11 items-center rounded-xl px-2 font-bold text-violet-800 outline-none hover:bg-white/70 focus-visible:ring-4 focus-visible:ring-violet-300">← Volver</button><section className="card mt-4" aria-labelledby="selection-title"><header className="mb-8 text-center">{eyebrow && <p className="font-black text-violet-700">{eyebrow}</p>}<h1 ref={headingRef} id="selection-title" tabIndex={-1} className="mt-2 text-3xl font-black tracking-tight text-slate-900 outline-none sm:text-5xl">{title}</h1><p className="mx-auto mt-3 max-w-2xl text-lg text-slate-600 sm:text-xl">{description}</p></header>{error && <p className="mb-6 rounded-2xl bg-rose-100 p-4 text-center font-bold text-rose-900" role="alert">{error}</p>}{children}</section></div></main>;
}
