import assert from "node:assert/strict";
import test from "node:test";

import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { PersistenceError } from "../../application/errors.ts";
import { emptyMultiplayerScore, type MultiplayerMember, type MultiplayerRoom } from "../../domain/multiplayer/types.ts";
import { DynamoDbMultiplayerRepository } from "./DynamoDbMultiplayerRepository.ts";

const room: MultiplayerRoom = {
  roomId: "room-1", roomCode: "AB7K2M", gameId: "animals", hostPlayerId: "ana", status: "WAITING",
  questionIds: ["q1", "q2"], currentQuestionIndex: -1, questionState: "NOT_STARTED", questionTimeLimitSeconds: 30,
  eligiblePlayerIds: [], answeredCount: 0, memberCount: 1, version: 1, createdAt: 1_000, expiresAt: 8_000,
};
const host: MultiplayerMember = {
  roomId: "room-1", playerId: "ana", displayName: "Ana", role: "HOST", participantTokenHash: "a".repeat(64),
  joinedAt: 1_000, score: emptyMultiplayerScore(), expiresAt: 8_000,
};

function cancelled(...codes: string[]) {
  return Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });
}

function recordingClient(handler: (command: object) => unknown = () => ({})) {
  const commands: object[] = [];
  return {
    commands,
    client: { send: async (command: object) => { commands.push(command); return handler(command); } },
  };
}

test("createRoom reserves the code, room and host in one conditional transaction; a code collision returns false", async () => {
  const { client, commands } = recordingClient();
  const repository = new DynamoDbMultiplayerRepository(client, "Multiplayer");
  assert.equal(await repository.createRoom(room, host, 2_500), true);
  const transaction = commands[0] as TransactWriteCommand;
  assert.ok(transaction instanceof TransactWriteCommand);
  const [reservation, meta, member] = transaction.input.TransactItems!.map((item) => item.Put!);
  assert.deepEqual(reservation.Item, { PK: "CODE#AB7K2M", SK: "RESERVATION", entityType: "ROOM_CODE", roomId: "room-1", roomCode: "AB7K2M", expiresAt: 8_000 });
  assert.match(reservation.ConditionExpression!, /attribute_not_exists\(PK\) OR #expiresAt <= :nowSeconds/);
  assert.equal(reservation.ExpressionAttributeValues![":nowSeconds"], 2);
  assert.equal(meta.Item!.PK, "ROOM#room-1");
  assert.equal(meta.Item!.SK, "META");
  assert.equal(meta.Item!.expiresAt, 8_000, "TTL attribute");
  assert.equal(member.Item!.SK, "PLAYER#ana");
  assert.equal(member.Item!.participantTokenHash, "a".repeat(64));
  assert.equal(member.Item!.totalPoints, 0, "score aggregates are top-level numbers (ADD-able)");

  const collision = new DynamoDbMultiplayerRepository({ send: async () => { throw cancelled("ConditionalCheckFailed", "None", "None"); } }, "Multiplayer");
  assert.equal(await collision.createRoom(room, host, 2_500), false);
  const failure = new DynamoDbMultiplayerRepository({ send: async () => { throw Object.assign(new Error("x"), { name: "ProvisionedThroughputExceededException" }); } }, "Multiplayer");
  await assert.rejects(failure.createRoom(room, host, 2_500), (error) => error instanceof PersistenceError && error.originalErrorName === "ProvisionedThroughputExceededException");
});

test("room-code lookup and room/member reads are strongly consistent key reads (no scans)", async () => {
  const { client, commands } = recordingClient((command) => {
    if (!(command instanceof GetCommand)) throw new Error("unexpected");
    const key = command.input.Key as { PK: string; SK: string };
    if (key.SK === "RESERVATION") return { Item: { roomId: "room-1" } };
    if (key.SK === "META") return { Item: { PK: "ROOM#room-1", SK: "META", ...room } };
    return { Item: { PK: "ROOM#room-1", SK: "PLAYER#ana", roomId: "room-1", playerId: "ana", displayName: "Ana", role: "HOST", participantTokenHash: "h", joinedAt: 1, expiresAt: 8_000, correctAnswers: 2, totalPoints: 2_500, connectionId: "c-1" } };
  });
  const repository = new DynamoDbMultiplayerRepository(client, "Multiplayer");
  assert.equal(await repository.findRoomIdByCode("AB7K2M"), "room-1");
  assert.deepEqual(await repository.getRoom("room-1"), room);
  const member = await repository.getMember("room-1", "ana");
  assert.equal(member!.connectionId, "c-1");
  assert.deepEqual(member!.score, { ...emptyMultiplayerScore(), correctAnswers: 2, totalPoints: 2_500 });
  assert.ok(commands.every((command) => command instanceof GetCommand && command.input.ConsistentRead === true));
});

test("listMembers and listAnswers query one room partition by sort-key prefix, paginating", async () => {
  const { client, commands } = recordingClient((command) => {
    assert.ok(command instanceof QueryCommand);
    return command.input.ExclusiveStartKey ? { Items: [] } : { Items: [], LastEvaluatedKey: { PK: "x", SK: "y" } };
  });
  const repository = new DynamoDbMultiplayerRepository(client, "Multiplayer");
  await repository.listMembers("room-1");
  await repository.listAnswers("room-1", "q1");
  const queries = commands as QueryCommand[];
  assert.equal(queries.length, 4);
  assert.deepEqual(queries[0].input.ExpressionAttributeValues, { ":pk": "ROOM#room-1", ":prefix": "PLAYER#" });
  assert.deepEqual(queries[2].input.ExpressionAttributeValues, { ":pk": "ROOM#room-1", ":prefix": "ANSWER#q1#" });
  assert.ok(queries.every((query) => query.input.ConsistentRead === true));
});

test("addMember increments capacity only while WAITING, below max and unexpired", async () => {
  const { client, commands } = recordingClient();
  const repository = new DynamoDbMultiplayerRepository(client, "Multiplayer");
  assert.equal(await repository.addMember({ ...host, playerId: "beto", role: "PLAYER" }, { maxPlayers: 8, nowMs: 3_000 }), true);
  const [update, put] = (commands[0] as TransactWriteCommand).input.TransactItems!;
  assert.equal(update.Update!.ConditionExpression, "#status = :waiting AND #memberCount < :maxPlayers AND #expiresAt > :nowSeconds");
  assert.equal(update.Update!.ExpressionAttributeValues![":maxPlayers"], 8);
  assert.equal(put.Put!.ConditionExpression, "attribute_not_exists(PK)");
  const full = new DynamoDbMultiplayerRepository({ send: async () => { throw cancelled("ConditionalCheckFailed", "None"); } }, "Multiplayer");
  assert.equal(await full.addMember(host, { maxPlayers: 8, nowMs: 3_000 }), false);
});

test("startRoom and openNextQuestion are version/state-conditioned updates", async () => {
  const { client, commands } = recordingClient();
  const repository = new DynamoDbMultiplayerRepository(client, "Multiplayer");
  const opening = { questionIndex: 0, questionStartedAt: 10, questionDeadlineAt: 30_010, eligiblePlayerIds: ["ana", "beto"] };
  assert.equal(await repository.startRoom("room-1", 3, opening), true);
  assert.equal(await repository.openNextQuestion("room-1", 0, { ...opening, questionIndex: 1 }), true);
  const [start, next] = commands as UpdateCommand[];
  assert.equal(start.input.ConditionExpression, "#status = :waiting AND #version = :expectedVersion");
  assert.match(start.input.UpdateExpression!, /#status = :inProgress/);
  assert.match(start.input.UpdateExpression!, /#version = #version \+ :one/);
  assert.equal(start.input.ExpressionAttributeValues![":expectedVersion"], 3);
  assert.equal(next.input.ConditionExpression, "#status = :inProgress AND #questionState = :revealed AND #currentQuestionIndex = :fromIndex");
  assert.match(next.input.UpdateExpression!, /REMOVE #lastReveal/);

  const conflict = new DynamoDbMultiplayerRepository({ send: async () => { throw Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" }); } }, "Multiplayer");
  assert.equal(await conflict.startRoom("room-1", 3, opening), false);
});

test("recordAnswer writes one answer and bumps answeredCount atomically; maps duplicate vs closed", async () => {
  const { client, commands } = recordingClient();
  const repository = new DynamoDbMultiplayerRepository(client, "Multiplayer");
  const answer = { roomId: "room-1", questionId: "q1", playerId: "ana", answerId: "a1", serverReceivedAtMs: 5_000, responseDurationMs: 4_000, isCorrect: true, expiresAt: 8_000 };
  assert.equal(await repository.recordAnswer(answer, 0, 5_000), "accepted");
  const [put, update] = (commands[0] as TransactWriteCommand).input.TransactItems!;
  assert.equal(put.Put!.Item!.SK, "ANSWER#q1#ana");
  assert.equal(put.Put!.ConditionExpression, "attribute_not_exists(PK)");
  assert.equal(update.Update!.ConditionExpression, "#status = :inProgress AND #questionState = :open AND #currentQuestionIndex = :questionIndex AND #questionDeadlineAt > :now");
  assert.equal(update.Update!.ExpressionAttributeValues![":now"], 5_000, "server time, never client time");

  const duplicate = new DynamoDbMultiplayerRepository({ send: async () => { throw cancelled("ConditionalCheckFailed", "None"); } }, "Multiplayer");
  assert.equal(await duplicate.recordAnswer(answer, 0, 5_000), "duplicate");
  const closed = new DynamoDbMultiplayerRepository({ send: async () => { throw cancelled("None", "ConditionalCheckFailed"); } }, "Multiplayer");
  assert.equal(await closed.recordAnswer(answer, 0, 5_000), "closed");
});

test("revealQuestion commits OPEN → REVEALED and the score ADDs in one transaction", async () => {
  const { client, commands } = recordingClient();
  const repository = new DynamoDbMultiplayerRepository(client, "Multiplayer");
  const reveal = { questionId: "q2", correctAnswerId: "a1", results: [] };
  const delta = { ...emptyMultiplayerScore(), correctAnswers: 1, totalPoints: 1_300, firstPlaceCorrectAnswers: 1, cumulativeCorrectResponseTimeMs: 900 };
  assert.equal(await repository.revealQuestion({ roomId: "room-1", questionIndex: 1, expectedAnsweredCount: 2, reveal, scoreDeltas: [{ playerId: "beto", delta }], finish: true }), true);
  const [meta, score] = (commands[0] as TransactWriteCommand).input.TransactItems!;
  assert.equal(meta.Update!.ConditionExpression, "#questionState = :open AND #currentQuestionIndex = :questionIndex AND #answeredCount = :expectedAnsweredCount");
  assert.match(meta.Update!.UpdateExpression!, /#status = :finished/);
  assert.equal(meta.Update!.ExpressionAttributeValues![":expectedAnsweredCount"], 2);
  assert.deepEqual(score.Update!.Key, { PK: "ROOM#room-1", SK: "PLAYER#beto" });
  assert.match(score.Update!.UpdateExpression!, /^ADD #correctAnswers :correctAnswers, #totalPoints :totalPoints/);
  assert.equal(score.Update!.ExpressionAttributeValues![":totalPoints"], 1_300);

  const lost = new DynamoDbMultiplayerRepository({ send: async () => { throw cancelled("ConditionalCheckFailed", "None"); } }, "Multiplayer");
  assert.equal(await lost.revealQuestion({ roomId: "room-1", questionIndex: 1, expectedAnsweredCount: 2, reveal, scoreDeltas: [], finish: false }), false);
});

test("bindConnection replaces the member connection and reverse lookup; releaseConnection is conditional and idempotent", async () => {
  const { client, commands } = recordingClient((command) => {
    if (command instanceof GetCommand) return { Item: { roomId: "room-1", playerId: "ana" } };
    if (command instanceof UpdateCommand) throw Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" });
    return {};
  });
  const repository = new DynamoDbMultiplayerRepository(client, "Multiplayer");
  await repository.bindConnection({ roomId: "room-1", playerId: "ana", connectionId: "new", previousConnectionId: "old", expiresAt: 8_000, nowMs: 5 });
  const items = (commands[0] as TransactWriteCommand).input.TransactItems!;
  assert.equal(items[0].Update!.ExpressionAttributeValues![":connectionId"], "new");
  assert.deepEqual(items[1].Put!.Item, { PK: "CONNECTION#new", SK: "META", entityType: "CONNECTION", roomId: "room-1", playerId: "ana", connectedAt: 5, expiresAt: 8_000 });
  assert.deepEqual(items[2].Delete!.Key, { PK: "CONNECTION#old", SK: "META" });

  // The member already moved to a newer connection: the stale one is removed, the member untouched.
  assert.deepEqual(await repository.releaseConnection("old"), { roomId: "room-1", playerId: "ana", wasActive: false });
  assert.ok(commands.some((command) => command instanceof DeleteCommand));
  const update = commands.find((command) => command instanceof UpdateCommand) as UpdateCommand;
  assert.equal(update.input.ConditionExpression, "#connectionId = :connectionId");

  const unknown = new DynamoDbMultiplayerRepository({ send: async () => ({}) }, "Multiplayer");
  assert.equal(await unknown.releaseConnection("missing"), null);
});
