import type {
  Category,
  Difficulty,
  GameSession,
  Player,
  Question,
  Result,
} from "../../domain/game/types.ts";

export const QUESTIONS_PER_GAME = 10;

interface QuestionSelection {
  categoryId: string;
  difficulty: Difficulty;
  count: number;
}

interface CreateGameSessionInput {
  player: Player;
  category: Category;
  difficulty: Difficulty;
  questions: Question[];
  random?: () => number;
}

export function selectQuestions(
  questions: readonly Question[],
  selection: QuestionSelection,
  random: () => number = Math.random,
): Question[] {
  const candidates = questions.filter(
    (question) =>
      question.categoryId === selection.categoryId &&
      question.difficulty === selection.difficulty,
  );

  if (candidates.length < selection.count) {
    throw new Error(
      `Se necesitan ${selection.count} preguntas disponibles para iniciar la partida.`,
    );
  }

  const shuffled = [...candidates];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }

  return shuffled.slice(0, selection.count);
}

export function createGameSession({
  player,
  category,
  difficulty,
  questions,
  random = Math.random,
}: CreateGameSessionInput): GameSession {
  return {
    revision: 0,
    player,
    category,
    difficulty,
    questions: selectQuestions(
      questions,
      { categoryId: category.id, difficulty, count: QUESTIONS_PER_GAME },
      random,
    ),
    currentQuestionIndex: 0,
    score: 0,
    answers: [],
    selectedAnswerId: null,
    status: "playing",
  };
}

export function submitAnswer(
  session: GameSession,
  answerId: string,
): GameSession {
  if (session.status !== "playing" || session.selectedAnswerId !== null) {
    return session;
  }

  const question = session.questions[session.currentQuestionIndex];
  const answer = question?.answers.find((candidate) => candidate.id === answerId);
  if (!question || !answer) return session;

  return {
    ...session,
    selectedAnswerId: answer.id,
    score: session.score + (answer.isCorrect ? 1 : 0),
    answers: [
      ...session.answers,
      { questionId: question.id, answerId: answer.id, isCorrect: answer.isCorrect },
    ],
  };
}

export function advanceSession(session: GameSession): GameSession {
  if (session.status !== "playing" || session.selectedAnswerId === null) {
    return session;
  }

  if (session.currentQuestionIndex === session.questions.length - 1) {
    return { ...session, status: "completed" };
  }

  return {
    ...session,
    currentQuestionIndex: session.currentQuestionIndex + 1,
    selectedAnswerId: null,
  };
}

export function buildResult(session: GameSession): Result {
  if (session.status !== "completed") {
    throw new Error("La partida todavía no ha terminado.");
  }

  return {
    player: session.player,
    category: session.category,
    difficulty: session.difficulty,
    score: session.score,
    total: session.questions.length,
  };
}

export function restartGameSession(
  session: GameSession,
  questions: Question[],
  random: () => number = Math.random,
): GameSession {
  return createGameSession({
    player: session.player,
    category: session.category,
    difficulty: session.difficulty,
    questions,
    random,
  });
}
