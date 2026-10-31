export const RECLAIM_API_BASE = "https://api.app.reclaim.ai/api";

export class ReclaimApiError extends Error {
  status: number;

  constructor(status: number, method: string, path: string, detail: string) {
    super(`Reclaim API ${method} ${path} failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "ReclaimApiError";
    this.status = status;
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Query = Record<string, string | number | boolean | undefined>;

export interface ReclaimClient {
  get<T>(path: string, query?: Query): Promise<T>;
  post<T>(path: string, body?: unknown, query?: Query): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

export function createReclaimClient(apiKey: string, fetchImpl: typeof fetch = fetch): ReclaimClient {
  if (!apiKey) throw new Error("Reclaim API key is empty");

  async function request<T>(method: Method, path: string, body?: unknown, query?: Query): Promise<T> {
    const url = new URL(RECLAIM_API_BASE + path);
    if (url.origin !== new URL(RECLAIM_API_BASE).origin) throw new Error(`Refusing to call ${url.origin}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ReclaimApiError(response.status, method, path, errorDetail(text));
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    get: (path, query) => request("GET", path, undefined, query),
    post: (path, body, query) => request("POST", path, body, query),
    patch: (path, body) => request("PATCH", path, body),
    delete: (path) => request("DELETE", path),
  };
}

function errorDetail(text: string): string {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.message ?? parsed?.error ?? parsed?.detail;
    if (typeof message === "string") return message.slice(0, 300);
  } catch {}
  return text.slice(0, 300);
}
