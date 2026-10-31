import { createHash, timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createReclaimClient } from "./reclaim.ts";
import { createServer } from "./tools.ts";

export function bearerMatches(header: string | null, secrets: string[]): boolean {
  const presented = header?.match(/^Bearer (.+)$/)?.[1];
  if (!presented) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const presentedDigest = digest(presented);
  return secrets.some((secret) => secret.length > 0 && timingSafeEqual(digest(secret), presentedDigest));
}

export function createHttpHandler(options: { apiKey: string; secrets: string[]; fetchImpl?: typeof fetch }) {
  const reclaim = createReclaimClient(options.apiKey, options.fetchImpl);
  const mcp = createMcpHandler(() => createServer(reclaim));
  return async (request: Request): Promise<Response> => {
    if (!bearerMatches(request.headers.get("authorization"), options.secrets)) {
      return new Response("Unauthorized", { status: 401 });
    }
    return mcp.fetch(request);
  };
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
