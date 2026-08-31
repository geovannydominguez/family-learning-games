"use client";

import { useEffect, useRef, useState } from "react";

import {
  advanceSession,
  buildResult,
  createGameSession,
  restartGameSession,
  submitAnswer,
} from "@/application/game/gameSession";
import type {
  Category,
  Difficulty,
  GameSession,
  GameSetup,
  Player,
} from "@/domain/game/types";

type FlowStep = "home" | "player" | "category" | "difficulty" | "game";

interface QuizGameProps {
  setup: GameSetup;
}

const difficultyOptions: Array<{
  id: Difficulty;
  label: string;
  icon: string;
  description: string;
}> = [
  { id: "easy", label: "Fácil", icon: "🌱", description: "Para empezar con calma" },
  { id: "normal", label: "Normal", icon: "⭐", description: "Un desafío equilibrado" },
  { id: "hard", label: "Difícil", icon: "🚀", description: "Para grandes exploradores" },
];

export function QuizGame({ setup }: QuizGameProps) {
  const [step, setStep] = useState<FlowStep>("home");
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [session, setSession] = useState<GameSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (step !== "home") headingRef.current?.focus();
  }, [session?.currentQuestionIndex, session?.status, step]);

  function choosePlayer(playerId: string) {
    const player = setup.players.find((candidate) => candidate.id === playerId);
    if (!player) {
      setError("No pudimos encontrar ese jugador. Elige uno de la lista.");
      return;
    }
    setSelectedPlayer(player);
    setSelectedCategory(null);
    setSession(null);
    setError(null);
    setStep("category");
  }

  function chooseCategory(categoryId: string) {
    const category = setup.categories.find(
      (candidate) => candidate.id === categoryId,
    );
    if (!category || !selectedPlayer) {
      setError("La selección no es válida. Vuelve a elegir jugador y categoría.");
      setStep(selectedPlayer ? "category" : "player");
      return;
    }
    setSelectedCategory(category);
    setSession(null);
    setError(null);
    setStep("difficulty");
  }

  function startGame(difficulty: Difficulty) {
    if (!selectedPlayer || !selectedCategory) {
      setError("Elige un jugador y una categoría antes de comenzar.");
      setStep(selectedPlayer ? "category" : "player");
      return;
    }

    try {
      setSession(
        createGameSession({
          player: selectedPlayer,
          category: selectedCategory,
          difficulty,
          questions: setup.questions,
        }),
      );
      setError(null);
      setStep("game");
    } catch (caughtError) {
      setSession(null);
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "No pudimos iniciar la partida.",
      );
    }
  }

  function chooseAnotherGame() {
    setSelectedCategory(null);
    setSession(null);
    setError(null);
    setStep(selectedPlayer ? "category" : "player");
  }

  if (step === "home") {
    return (
      <main className="page-shell flex items-center justify-center py-12 sm:py-20">
        <section className="card w-full max-w-4xl text-center" aria-labelledby="welcome-title">
          <span className="text-7xl" aria-hidden="true">🎲</span>
          <h1 id="welcome-title" className="mt-5 text-4xl font-black tracking-tight text-slate-900 sm:text-6xl">
            Family Learning Games
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-xl leading-relaxed text-slate-700 sm:text-2xl">
            Aprendamos, juguemos y descubramos cosas nuevas en familia.
          </p>
          <button className="button-primary mt-9 min-w-56" onClick={() => setStep("player")} type="button">
            Comenzar
          </button>
        </section>
      </main>
    );
  }

  if (step === "player") {
    return (
      <SelectionLayout
        headingRef={headingRef}
        eyebrow="Paso 1 de 3"
        title="¿Quién va a jugar?"
        description="Elige un jugador para personalizar la partida."
        error={error}
        onBack={() => { setError(null); setStep("home"); }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {setup.players.map((player) => (
            <button key={player.id} type="button" onClick={() => choosePlayer(player.id)} className="selection-card">
              <span className="text-6xl" aria-hidden="true">{player.avatar}</span>
              <span className="mt-3 text-2xl font-black text-slate-900">{player.name}</span>
            </button>
          ))}
        </div>
      </SelectionLayout>
    );
  }

  if (step === "category") {
    return (
      <SelectionLayout
        headingRef={headingRef}
        eyebrow={`Jugando como ${selectedPlayer?.name ?? "familia"}`}
        title="¿Qué quieres aprender?"
        description="Elige una categoría para tu próxima partida."
        error={error}
        onBack={() => { setError(null); setStep("player"); }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          {setup.categories.map((category) => (
            <button key={category.id} type="button" onClick={() => chooseCategory(category.id)} className="selection-card text-left">
              <span className="text-6xl" aria-hidden="true">{category.icon}</span>
              <span className="mt-3 block text-2xl font-black text-slate-900">{category.name}</span>
              <span className="mt-2 block text-base leading-relaxed text-slate-600">{category.description}</span>
            </button>
          ))}
        </div>
      </SelectionLayout>
    );
  }

  if (step === "difficulty") {
    return (
      <SelectionLayout
        headingRef={headingRef}
        eyebrow={`${selectedPlayer?.avatar ?? ""} ${selectedPlayer?.name ?? ""} · ${selectedCategory?.icon ?? ""} ${selectedCategory?.name ?? ""}`}
        title="Elige la dificultad"
        description="La partida tendrá exactamente 10 preguntas."
        error={error}
        onBack={() => { setError(null); setStep("category"); }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          {difficultyOptions.map((difficulty) => (
            <button key={difficulty.id} type="button" onClick={() => startGame(difficulty.id)} className="selection-card">
              <span className="text-6xl" aria-hidden="true">{difficulty.icon}</span>
              <span className="mt-3 block text-2xl font-black text-slate-900">{difficulty.label}</span>
              <span className="mt-2 block text-base text-slate-600">{difficulty.description}</span>
            </button>
          ))}
        </div>
      </SelectionLayout>
    );
  }

  if (!session) {
    return (
      <SelectionLayout
        headingRef={headingRef}
        title="No pudimos abrir la partida"
        description="Vuelve a elegir una categoría para intentarlo otra vez."
        error={error}
        onBack={chooseAnotherGame}
      />
    );
  }

  if (session.status === "completed") {
    const result = buildResult(session);
    const perfectScore = result.score === result.total;

    return (
      <main className="page-shell flex items-center justify-center py-10 sm:py-16">
        <section className="card w-full max-w-2xl text-center" aria-labelledby="result-title">
          <span className="mb-4 block text-7xl" aria-hidden="true">{perfectScore ? "🏆" : "🎉"}</span>
          <h1 ref={headingRef} id="result-title" tabIndex={-1} className="text-3xl font-black tracking-tight text-slate-900 outline-none sm:text-5xl">
            {perfectScore ? `¡Excelente, ${result.player.name}!` : `¡Muy bien, ${result.player.name}!`}
          </h1>
          <p className="mt-5 text-xl text-slate-700 sm:text-2xl">
            Acertaste <strong className="text-violet-700">{result.score}</strong> de <strong>{result.total}</strong> preguntas.
          </p>
          <p className="mt-3 text-lg text-slate-600">
            {perfectScore ? "Tu curiosidad llegó muy lejos." : "Cada intento nos ayuda a aprender."}
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <button className="button-primary" onClick={() => setSession(restartGameSession(session, setup.questions))} type="button">
              Jugar nuevamente
            </button>
            <button className="button-secondary" onClick={chooseAnotherGame} type="button">
              Elegir otro juego
            </button>
          </div>
        </section>
      </main>
    );
  }

  const question = session.questions[session.currentQuestionIndex];
  if (!question) {
    return (
      <SelectionLayout
        headingRef={headingRef}
        title="No encontramos la pregunta"
        description="La partida no puede continuar con estos datos."
        error="Elige otra categoría para iniciar una partida nueva."
        onBack={chooseAnotherGame}
      />
    );
  }

  const selectedAnswer = question.answers.find(
    (answer) => answer.id === session.selectedAnswerId,
  );
  const correctAnswer = question.answers.find((answer) => answer.isCorrect);
  const hasAnswered = selectedAnswer !== undefined;
  const progress = ((session.currentQuestionIndex + 1) / session.questions.length) * 100;

  return (
    <main className="page-shell py-8 sm:py-12">
      <div className="mx-auto w-full max-w-3xl">
        <button type="button" onClick={chooseAnotherGame} className="inline-flex min-h-11 items-center rounded-xl px-2 font-bold text-violet-800 outline-none hover:bg-white/70 focus-visible:ring-4 focus-visible:ring-violet-300">
          ← Elegir otro juego
        </button>

        <section className="card mt-4" aria-labelledby="question-title">
          <p className="mb-4 font-bold text-violet-800">
            {session.player.avatar} {session.player.name} · {session.category.icon} {session.category.name}
          </p>
          <div className="flex items-center justify-between gap-4 text-sm font-bold text-slate-600 sm:text-base">
            <span>Pregunta {session.currentQuestionIndex + 1} de {session.questions.length}</span>
            <span aria-label={`${session.score} respuestas correctas`}>⭐ {session.score} puntos</span>
          </div>
          <div className="mt-3 h-3 overflow-hidden rounded-full bg-violet-100" role="progressbar" aria-label="Progreso de la partida" aria-valuemin={1} aria-valuemax={session.questions.length} aria-valuenow={session.currentQuestionIndex + 1}>
            <div className="h-full rounded-full bg-violet-600 transition-all" style={{ width: `${progress}%` }} />
          </div>

          <fieldset className="mt-8">
            <legend className="w-full">
              {question.emoji && <span className="mb-4 block text-center text-7xl" aria-hidden="true">{question.emoji}</span>}
              <h1 ref={headingRef} id="question-title" tabIndex={-1} className="text-2xl font-black leading-tight text-slate-900 outline-none sm:text-4xl">
                {question.text}
              </h1>
            </legend>
            <div className="mt-7 grid gap-3 sm:grid-cols-2">
              {question.answers.map((answer) => {
                const isSelected = selectedAnswer?.id === answer.id;
                let stateClass = "border-slate-200 bg-white hover:border-violet-400 hover:bg-violet-50";
                if (hasAnswered && answer.isCorrect) stateClass = "border-emerald-500 bg-emerald-50 text-emerald-900";
                else if (hasAnswered && isSelected) stateClass = "border-rose-500 bg-rose-50 text-rose-900";

                return (
                  <button key={answer.id} type="button" disabled={hasAnswered} aria-pressed={isSelected} onClick={() => setSession((current) => current ? submitAnswer(current, answer.id) : current)} className={`min-h-16 rounded-2xl border-2 px-5 py-4 text-left text-lg font-bold shadow-sm outline-none transition focus-visible:ring-4 focus-visible:ring-violet-300 disabled:cursor-default disabled:opacity-100 ${stateClass}`}>
                    {answer.text}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-7 min-h-24" aria-live="polite">
            {hasAnswered && (
              <div className={`rounded-2xl p-4 text-lg font-bold ${selectedAnswer.isCorrect ? "bg-emerald-100 text-emerald-900" : "bg-rose-100 text-rose-900"}`}>
                {selectedAnswer.isCorrect ? "¡Correcto! Muy buen trabajo." : `Casi. La respuesta correcta es ${correctAnswer?.text ?? "otra opción"}.`}
              </div>
            )}
          </div>

          <button type="button" onClick={() => setSession((current) => current ? advanceSession(current) : current)} disabled={!hasAnswered} className="button-primary mt-2 w-full disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500">
            {session.currentQuestionIndex === session.questions.length - 1 ? "Ver resultado" : "Siguiente pregunta"}
          </button>
        </section>
      </div>
    </main>
  );
}

interface SelectionLayoutProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  eyebrow?: string;
  title: string;
  description: string;
  error?: string | null;
  onBack: () => void;
  children?: React.ReactNode;
}

function SelectionLayout({ headingRef, eyebrow, title, description, error, onBack, children }: SelectionLayoutProps) {
  return (
    <main className="page-shell py-8 sm:py-14">
      <div className="mx-auto w-full max-w-5xl">
        <button type="button" onClick={onBack} className="inline-flex min-h-11 items-center rounded-xl px-2 font-bold text-violet-800 outline-none hover:bg-white/70 focus-visible:ring-4 focus-visible:ring-violet-300">
          ← Volver
        </button>
        <section className="card mt-4" aria-labelledby="selection-title">
          <header className="mb-8 text-center">
            {eyebrow && <p className="font-black text-violet-700">{eyebrow}</p>}
            <h1 ref={headingRef} id="selection-title" tabIndex={-1} className="mt-2 text-3xl font-black tracking-tight text-slate-900 outline-none sm:text-5xl">{title}</h1>
            <p className="mx-auto mt-3 max-w-2xl text-lg text-slate-600 sm:text-xl">{description}</p>
          </header>
          {error && <p className="mb-6 rounded-2xl bg-rose-100 p-4 text-center font-bold text-rose-900" role="alert">{error}</p>}
          {children}
        </section>
      </div>
    </main>
  );
}
