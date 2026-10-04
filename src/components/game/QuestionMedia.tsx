"use client";

import { useEffect, useRef, useState } from "react";

import type { PublicQuestionImage } from "@/application/media/questionImages";
import { createGameApiClient } from "@/infrastructure/http/GameApiClient";
import { QuestionAudioController, type QuestionAudioStatus } from "./questionAudio";

const audioLabels: Record<QuestionAudioStatus, { icon: string; text: string }> = {
  idle: { icon: "🔊", text: "Escuchar pregunta" },
  loading: { icon: "⏳", text: "Preparando audio…" },
  playing: { icon: "🔊", text: "Escuchar otra vez" },
  error: { icon: "🔊", text: "Intentar escuchar otra vez" },
};

/**
 * v0.8 "Listen" action (ADR-017). Starts only on click — never autoplays — and
 * never blocks answering: errors show a small non-blocking message.
 */
export function QuestionAudioButton({ gameId, questionId }: { gameId: string; questionId: string }) {
  const [status, setStatus] = useState<QuestionAudioStatus>("idle");
  const audioRef = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<QuestionAudioController | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = new QuestionAudioController({
      fetchAudio: (game, question) => createGameApiClient().getQuestionAudio(game, question),
      onStatusChange: setStatus,
      player: {
        play: async (url) => {
          const audio = audioRef.current;
          if (!audio) throw new Error("Audio element is unavailable.");
          if (audio.src !== url) audio.src = url;
          audio.currentTime = 0;
          await audio.play();
        },
        stop: () => {
          const audio = audioRef.current;
          if (!audio) return;
          audio.pause();
          if (audio.readyState > 0) audio.currentTime = 0;
        },
      },
    });
  }

  // Duplicate clicks while loading are ignored by the controller (FR-0873); the
  // button stays focusable (aria-disabled) so keyboard focus is not lost.
  // A new question cancels any pending/playing audio of the previous one.
  useEffect(() => {
    const controller = controllerRef.current;
    return () => controller?.reset();
  }, [gameId, questionId]);

  const loading = status === "loading";
  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={() => void controllerRef.current?.listen(gameId, questionId)}
        aria-disabled={loading}
        aria-busy={loading}
        className="inline-flex min-h-14 min-w-14 items-center justify-center gap-2 rounded-2xl border-2 border-violet-300 bg-violet-50 px-5 text-lg font-black text-violet-800 shadow-sm outline-none transition hover:bg-violet-100 focus-visible:ring-4 focus-visible:ring-violet-300 aria-disabled:cursor-wait aria-disabled:opacity-70"
      >
        <span aria-hidden="true">{audioLabels[status].icon}</span>
        <span>{audioLabels[status].text}</span>
      </button>
      <audio ref={audioRef} preload="none" onEnded={() => controllerRef.current?.ended()} className="hidden" />
      <p className="mt-2 min-h-6 text-base font-bold text-slate-600" role="status" aria-live="polite">
        {status === "error" ? "No pudimos reproducir el audio. Puedes seguir jugando." : ""}
      </p>
    </div>
  );
}

/** v0.8 optional controlled image (ADR-016). A failed load hides it; the question stays playable. */
export function QuestionImageView({ image }: { image: PublicQuestionImage }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <div className="mx-auto mt-8 flex aspect-[4/3] w-full max-w-md items-center justify-center overflow-hidden rounded-3xl bg-violet-50">
      {/* Short-lived signed URL from the private media bucket: next/image optimization does not apply. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.url}
        alt={image.altText}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-full w-full object-contain"
      />
    </div>
  );
}
