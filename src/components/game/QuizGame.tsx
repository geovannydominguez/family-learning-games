"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type { AnswerFeedback, GameSetupResponse, PublicGame, PublicGameSession } from "@/application/game/gameSessionContracts";
import type { Category, Difficulty, Player } from "@/domain/game/types";
import { createGameApiClient } from "@/infrastructure/http/GameApiClient";
import { buildStartSessionCommand, gameUiErrorMessage } from "./gameUiState";

type FlowStep = "home" | "player" | "category" | "difficulty" | "generate" | "game";

const difficultyOptions: Array<{ id: Difficulty; label: string; icon: string; description: string }> = [
  { id: "easy", label: "Fácil", icon: "🌱", description: "Para empezar con calma" },
  { id: "normal", label: "Normal", icon: "⭐", description: "Un desafío equilibrado" },
  { id: "hard", label: "Difícil", icon: "🚀", description: "Para grandes exploradores" },
];

export function QuizGame() {
  const [setup, setSetup] = useState<GameSetupResponse | null>(null);
  const [step, setStep] = useState<FlowStep>("home");
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [selectedGameId, setSelectedGameId] = useState<string | undefined>();
  const [generationTopic, setGenerationTopic] = useState("");
  const [generationDifficulty, setGenerationDifficulty] = useState<Difficulty>("easy");
  const [generatedGame, setGeneratedGame] = useState<PublicGame | null>(null);
  const [session, setSession] = useState<PublicGameSession | null>(null);
  const [feedback, setFeedback] = useState<AnswerFeedback | null>(null);
  const [pendingSession, setPendingSession] = useState<PublicGameSession | null>(null);
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

  useEffect(() => { void loadSetup(); }, [loadSetup]);
  useEffect(() => {
    if (step !== "home") headingRef.current?.focus();
  }, [session?.currentQuestionIndex, session?.status, step]);

  function choosePlayer(playerId: string) {
    const player = setup?.players.find((candidate) => candidate.id === playerId);
    if (!player) return setError("No pudimos encontrar ese jugador. Elige uno de la lista.");
    setSelectedPlayer(player);
    setSelectedCategory(null);
    setSelectedGameId(undefined);
    setGeneratedGame(null);
    setSession(null);
    setError(null);
    setStep("category");
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

  async function startGame(difficulty: Difficulty, gameId = selectedGameId) {
    if (!selectedPlayer || !selectedCategory) return;
    setSubmitting(true);
    setError(null);
    try {
      const started = await createGameApiClient().startSession(buildStartSessionCommand(
        selectedPlayer.id,
        selectedCategory.id,
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
        playerId: selectedPlayer.id,
      });
      setGeneratedGame(game);
      setSelectedCategory(game.category);
      setSelectedGameId(game.id);
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
    <SelectionLayout headingRef={headingRef} eyebrow="Paso 1 de 3" title="¿Quién va a jugar?" description="Elige un jugador para personalizar la partida." error={error} onBack={() => setStep("home")}>
      <div className="grid gap-4 sm:grid-cols-2">{setup.players.map((player) => <button key={player.id} type="button" onClick={() => choosePlayer(player.id)} className="selection-card"><span className="text-6xl" aria-hidden="true">{player.avatar}</span><span className="mt-3 text-2xl font-black text-slate-900">{player.name}</span></button>)}</div>
    </SelectionLayout>
  );

  if (step === "category") return (
    <SelectionLayout headingRef={headingRef} eyebrow={`Jugando como ${selectedPlayer?.name ?? "familia"}`} title="¿Qué quieres aprender?" description="Elige una categoría para tu próxima partida." error={error} onBack={() => setStep("player")}>
      <div className="grid gap-4 sm:grid-cols-3">{setup.categories.map((category) => <button key={category.id} type="button" onClick={() => chooseCategory(category.id)} className="selection-card text-left"><span className="text-6xl" aria-hidden="true">{category.icon}</span><span className="mt-3 block text-2xl font-black text-slate-900">{category.name}</span><span className="mt-2 block text-base leading-relaxed text-slate-600">{category.description}</span></button>)}</div>
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
    <SelectionLayout headingRef={headingRef} eyebrow={`${selectedPlayer?.avatar ?? ""} ${selectedPlayer?.name ?? ""} · ${selectedCategory?.icon ?? ""} ${selectedCategory?.name ?? ""}`} title="Elige la dificultad" description="La partida tendrá exactamente 10 preguntas." error={error} onBack={() => setStep("category")}>
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

function StatusCard({ title, description, busy = false, actionLabel, onAction }: { title: string; description: string; busy?: boolean; actionLabel?: string; onAction?: () => void }) {
  return <main className="page-shell flex items-center justify-center py-12 sm:py-20"><section className="card w-full max-w-2xl text-center" aria-live="polite" aria-busy={busy}><span className="text-7xl" aria-hidden="true">{busy ? "⏳" : "🧩"}</span><h1 className="mt-5 text-3xl font-black text-slate-900 sm:text-5xl">{title}</h1><p className="mx-auto mt-4 max-w-xl text-lg text-slate-700">{description}</p>{actionLabel && onAction && <button className="button-primary mt-7" type="button" onClick={onAction}>{actionLabel}</button>}</section></main>;
}

interface SelectionLayoutProps { headingRef: React.RefObject<HTMLHeadingElement | null>; eyebrow?: string; title: string; description: string; error?: string | null; onBack: () => void; children?: React.ReactNode; }
function SelectionLayout({ headingRef, eyebrow, title, description, error, onBack, children }: SelectionLayoutProps) {
  return <main className="page-shell py-8 sm:py-14"><div className="mx-auto w-full max-w-5xl"><button type="button" onClick={onBack} className="inline-flex min-h-11 items-center rounded-xl px-2 font-bold text-violet-800 outline-none hover:bg-white/70 focus-visible:ring-4 focus-visible:ring-violet-300">← Volver</button><section className="card mt-4" aria-labelledby="selection-title"><header className="mb-8 text-center">{eyebrow && <p className="font-black text-violet-700">{eyebrow}</p>}<h1 ref={headingRef} id="selection-title" tabIndex={-1} className="mt-2 text-3xl font-black tracking-tight text-slate-900 outline-none sm:text-5xl">{title}</h1><p className="mx-auto mt-3 max-w-2xl text-lg text-slate-600 sm:text-xl">{description}</p></header>{error && <p className="mb-6 rounded-2xl bg-rose-100 p-4 text-center font-bold text-rose-900" role="alert">{error}</p>}{children}</section></div></main>;
}
