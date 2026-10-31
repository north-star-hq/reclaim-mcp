import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { bearerMatches, createHttpHandler } from "../src/http.ts";

const fakeReclaimFetch: typeof fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname === "/api/timeschemes") return Response.json([{ id: "fo-1", title: "Focus", features: [] }]);
  return new Response("not found", { status: 404 });
};

function handlerFetch(secret: string): typeof fetch {
  const handle = createHttpHandler({ apiKey: "k", secrets: ["s-alice", "s-bob"], fetchImpl: fakeReclaimFetch });
  return async (input, init) => {
    const request = new Request(input, init);
    request.headers.set("authorization", `Bearer ${secret}`);
    return handle(request);
  };
}

test("bearerMatches accepts only listed secrets", () => {
  assert.equal(bearerMatches("Bearer s-alice", ["s-alice", "s-bob"]), true);
  assert.equal(bearerMatches("Bearer s-bob", ["s-alice", "s-bob"]), true);
  assert.equal(bearerMatches("Bearer nope", ["s-alice"]), false);
  assert.equal(bearerMatches("s-alice", ["s-alice"]), false);
  assert.equal(bearerMatches(null, ["s-alice"]), false);
  assert.equal(bearerMatches("Bearer ", [""]), false);
});

test("requests without a valid secret get 401 and never reach Reclaim", async () => {
  let reclaimCalls = 0;
  const handle = createHttpHandler({
    apiKey: "k",
    secrets: ["s-alice"],
    fetchImpl: async () => {
      reclaimCalls++;
      return Response.json([]);
    },
  });
  const response = await handle(new Request("https://x/api/mcp", { method: "POST", body: "{}" }));
  assert.equal(response.status, 401);
  assert.equal(reclaimCalls, 0);
});

test("an MCP client with a valid secret can list and call tools over HTTP", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://x/api/mcp"), { fetch: handlerFetch("s-bob") }));
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "create_task"));
  const result: any = await client.callTool({ name: "list_hours", arguments: {} });
  assert.equal(JSON.parse(result.content[0].text)[0].title, "Focus");
  await client.close();
});
