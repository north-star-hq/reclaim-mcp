import { createHttpHandler, requireEnv } from "../src/http.ts";

const handle = createHttpHandler({
  apiKey: requireEnv("RECLAIM_API_KEY"),
  secrets: requireEnv("MCP_SECRETS").split(","),
});

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
