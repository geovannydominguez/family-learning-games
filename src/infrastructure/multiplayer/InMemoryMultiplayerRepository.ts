import type { ConnectionBinding, MultiplayerRepository, QuestionOpening, RecordAnswerOutcome } from "../../application/multiplayer/ports.ts";
import { addScores } from "../../domain/multiplayer/scoring.ts";
import type { MultiplayerAnswer, MultiplayerMember, MultiplayerRoom } from "../../domain/multiplayer/types.ts";

/**
 * In-memory `MultiplayerRepository` for tests and local wiring. It enforces
 * the same conditions as the DynamoDB implementation so concurrency and
 * idempotency rules can be exercised without AWS. Values are cloned on the
 * way in and out to mimic a real store.
 */
export class InMemoryMultiplayerRepository implements MultiplayerRepository {
  readonly rooms = new Map<string, MultiplayerRoom>();
  readonly members = new Map<string, MultiplayerMember>();
  readonly answers = new Map<string, MultiplayerAnswer>();
  readonly connections = new Map<string, ConnectionBinding & { expiresAt: number }>();
  readonly codes = new Map<string, { roomId: string; expiresAt: number }>();

  async createRoom(room: MultiplayerRoom, host: MultiplayerMember, nowMs: number): Promise<boolean> {
    const reservation = this.codes.get(room.roomCode);
    if (reservation && reservation.expiresAt * 1_000 > nowMs) return false;
    if (this.rooms.has(room.roomId)) return false;
    this.codes.set(room.roomCode, { roomId: room.roomId, expiresAt: room.expiresAt });
    this.rooms.set(room.roomId, clone(room));
    this.members.set(memberKey(host.roomId, host.playerId), clone(host));
    return true;
  }

  async findRoomIdByCode(roomCode: string): Promise<string | null> {
    return this.codes.get(roomCode)?.roomId ?? null;
  }

  async getRoom(roomId: string): Promise<MultiplayerRoom | null> {
    const room = this.rooms.get(roomId);
    return room ? clone(room) : null;
  }

  async getMember(roomId: string, playerId: string): Promise<MultiplayerMember | null> {
    const member = this.members.get(memberKey(roomId, playerId));
    return member ? clone(member) : null;
  }

  async listMembers(roomId: string): Promise<MultiplayerMember[]> {
    return [...this.members.values()].filter((member) => member.roomId === roomId).map(clone);
  }

  async addMember(member: MultiplayerMember, limits: { maxPlayers: number; nowMs: number }): Promise<boolean> {
    const room = this.rooms.get(member.roomId);
    const key = memberKey(member.roomId, member.playerId);
    if (!room || room.status !== "WAITING" || room.memberCount >= limits.maxPlayers || room.expiresAt * 1_000 <= limits.nowMs || this.members.has(key)) {
      return false;
    }
    room.memberCount += 1;
    room.version += 1;
    this.members.set(key, clone(member));
    return true;
  }

  async startRoom(roomId: string, expectedVersion: number, opening: QuestionOpening): Promise<boolean> {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== "WAITING" || room.version !== expectedVersion) return false;
    room.status = "IN_PROGRESS";
    applyOpening(room, opening);
    return true;
  }

  async openNextQuestion(roomId: string, fromQuestionIndex: number, opening: QuestionOpening): Promise<boolean> {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== "IN_PROGRESS" || room.questionState !== "REVEALED" || room.currentQuestionIndex !== fromQuestionIndex) return false;
    applyOpening(room, opening);
    return true;
  }

  async recordAnswer(answer: MultiplayerAnswer, questionIndex: number, nowMs: number): Promise<RecordAnswerOutcome> {
    const key = answerKey(answer.roomId, answer.questionId, answer.playerId);
    if (this.answers.has(key)) return "duplicate";
    const room = this.rooms.get(answer.roomId);
    if (
      !room || room.status !== "IN_PROGRESS" || room.questionState !== "OPEN"
      || room.currentQuestionIndex !== questionIndex || (room.questionDeadlineAt ?? 0) <= nowMs
    ) {
      return "closed";
    }
    this.answers.set(key, clone(answer));
    room.answeredCount += 1;
    return "accepted";
  }

  async listAnswers(roomId: string, questionId: string): Promise<MultiplayerAnswer[]> {
    return [...this.answers.values()].filter((answer) => answer.roomId === roomId && answer.questionId === questionId).map(clone);
  }

  async revealQuestion(input: Parameters<MultiplayerRepository["revealQuestion"]>[0]): Promise<boolean> {
    const room = this.rooms.get(input.roomId);
    if (
      !room || room.questionState !== "OPEN" || room.currentQuestionIndex !== input.questionIndex
      || room.answeredCount !== input.expectedAnsweredCount
    ) {
      return false;
    }
    const members = input.scoreDeltas.map(({ playerId }) => this.members.get(memberKey(input.roomId, playerId)));
    if (members.some((member) => !member)) return false;
    room.questionState = "REVEALED";
    room.lastReveal = clone(input.reveal);
    room.version += 1;
    if (input.finish) room.status = "FINISHED";
    input.scoreDeltas.forEach(({ delta }, index) => {
      const member = members[index] as MultiplayerMember;
      member.score = addScores(member.score, delta);
    });
    return true;
  }

  async bindConnection(binding: Parameters<MultiplayerRepository["bindConnection"]>[0]): Promise<void> {
    const member = this.members.get(memberKey(binding.roomId, binding.playerId));
    if (!member) throw new Error("Member does not exist.");
    member.connectionId = binding.connectionId;
    if (binding.previousConnectionId) this.connections.delete(binding.previousConnectionId);
    this.connections.set(binding.connectionId, { roomId: binding.roomId, playerId: binding.playerId, expiresAt: binding.expiresAt });
  }

  async getConnection(connectionId: string): Promise<ConnectionBinding | null> {
    const connection = this.connections.get(connectionId);
    return connection ? { roomId: connection.roomId, playerId: connection.playerId } : null;
  }

  async releaseConnection(connectionId: string): Promise<(ConnectionBinding & { wasActive: boolean }) | null> {
    const connection = this.connections.get(connectionId);
    if (!connection) return null;
    this.connections.delete(connectionId);
    const member = this.members.get(memberKey(connection.roomId, connection.playerId));
    const wasActive = member?.connectionId === connectionId;
    if (member && wasActive) delete member.connectionId;
    return { roomId: connection.roomId, playerId: connection.playerId, wasActive };
  }
}

function applyOpening(room: MultiplayerRoom, opening: QuestionOpening): void {
  room.currentQuestionIndex = opening.questionIndex;
  room.questionState = "OPEN";
  room.questionStartedAt = opening.questionStartedAt;
  room.questionDeadlineAt = opening.questionDeadlineAt;
  room.eligiblePlayerIds = [...opening.eligiblePlayerIds];
  room.answeredCount = 0;
  delete room.lastReveal;
  room.version += 1;
}

function memberKey(roomId: string, playerId: string): string {
  return `${roomId}/${playerId}`;
}

function answerKey(roomId: string, questionId: string, playerId: string): string {
  return `${roomId}/${questionId}/${playerId}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
