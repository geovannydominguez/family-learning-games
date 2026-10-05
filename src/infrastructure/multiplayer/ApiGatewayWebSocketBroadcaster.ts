import { PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

import type { MultiplayerServerEvent } from "../../application/multiplayer/contracts.ts";
import type { BroadcastOutcome, MultiplayerBroadcaster } from "../../application/multiplayer/ports.ts";

export interface ManagementApiSendClient {
  send(command: PostToConnectionCommand): Promise<unknown>;
}

/**
 * Pushes multiplayer events through the API Gateway Management API
 * (`postToConnection`, ADR-018). A connection that no longer exists (410
 * Gone) is reported as `"gone"` so the caller can drop the stale mapping;
 * any other failure is thrown for the caller to log per connection.
 */
export class ApiGatewayWebSocketBroadcaster implements MultiplayerBroadcaster {
  private readonly client: ManagementApiSendClient;

  constructor(client: ManagementApiSendClient) {
    this.client = client;
  }

  async send(connectionId: string, event: MultiplayerServerEvent): Promise<BroadcastOutcome> {
    try {
      await this.client.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: new TextEncoder().encode(JSON.stringify(event)),
      }));
      return "delivered";
    } catch (error) {
      if (isGone(error)) return "gone";
      throw error;
    }
  }
}

function isGone(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "GoneException" || candidate.$metadata?.httpStatusCode === 410;
}
