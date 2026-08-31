import { loadGameSetup } from "@/application/game/loadGameSetup";
import { QuizGame } from "@/components/game/QuizGame";
import { gameRepository } from "@/repositories/game";

export default async function Home() {
  const setup = await loadGameSetup(gameRepository);

  return <QuizGame setup={setup} />;
}
