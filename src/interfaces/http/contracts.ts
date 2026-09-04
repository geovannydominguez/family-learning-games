export interface HttpRequest {
  requestId: string;
  method: string;
  path: string;
  body?: string | null;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface RequestLog {
  level: "info" | "error";
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  error?: {
    category: "persistence" | "unexpected";
    name: string;
    operation: string;
    resourceId?: string;
  };
}
