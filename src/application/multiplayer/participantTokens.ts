import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import type { ParticipantTokenService, RoomCodeGenerator } from "./ports.ts";

/**
 * ADR-020 participant tokens: 256 random bits, returned once, persisted only
 * as a SHA-256 hash. A fast hash is sufficient because the token is
 * high-entropy random data, not a human password.
 */
export const participantTokens: ParticipantTokenService = {
  generate: () => randomBytes(32).toString("base64url"),
  hash: (token) => sha256Hex(token),
  matches: (token, storedHash) => {
    const presented = Buffer.from(sha256Hex(token), "hex");
    const stored = Buffer.from(storedHash, "hex");
    return presented.length === stored.length && timingSafeEqual(presented, stored);
  },
};

/** Uppercase alphabet without visually ambiguous characters (0/O, 1/I/L). */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;
export const roomCodePattern = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** The room code is a human-friendly identifier, not a secret (ADR-020). */
export const randomRoomCodes: RoomCodeGenerator = {
  generate: () => Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]).join(""),
};

/** Short one-way digest for correlating transport identifiers in logs without exposing them. */
export function logHash(value: string): string {
  return sha256Hex(value).slice(0, 16);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
