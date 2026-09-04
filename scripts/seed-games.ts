import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, type BatchWriteCommandInput } from "@aws-sdk/lib-dynamodb";

import gameData from "../src/data/games.json" with { type: "json" };
import { buildGameSeedRecords, type GameSeedSource } from "../src/infrastructure/repositories/gameSeed.ts";

const tableName = readTableName(process.argv.slice(2), process.env.GAMES_TABLE_NAME);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const records = buildGameSeedRecords(gameData as GameSeedSource);

for (let offset = 0; offset < records.length; offset += 25) {
  const requests = records.slice(offset, offset + 25).map((Item) => ({ PutRequest: { Item } }));
  let pending: NonNullable<NonNullable<BatchWriteCommandInput["RequestItems"]>[string]> = requests;
  do {
    const result = await client.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
    pending = result.UnprocessedItems?.[tableName] ?? [];
  } while (pending.length > 0);
}

console.log(`Seeded ${records.length} games into ${tableName}.`);

function readTableName(args: string[], environmentValue: string | undefined): string {
  const flagIndex = args.indexOf("--table-name");
  const value = flagIndex >= 0 ? args[flagIndex + 1] : environmentValue;
  if (!value) {
    throw new Error("Provide the Games table with --table-name <name> or GAMES_TABLE_NAME.");
  }
  return value;
}
