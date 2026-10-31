import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ReclaimClient } from "../src/reclaim.ts";
import { createServer } from "../src/tools.ts";

const HOURS = [
  { id: "ws-1", title: "Working Hours", taskCategory: "WORK", features: ["TASK_ASSIGNMENT"] },
  { id: "ps-1", title: "Personal Hours", taskCategory: "PERSONAL", features: ["TASK_ASSIGNMENT"] },
  { id: "fo-1", title: "Focus", policyType: "CUSTOM", taskCategory: "WORK", taskTargetCalendar: { id: 9, name: "Focus" }, features: ["TASK_ASSIGNMENT"] },
];

function fakeReclaim() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const echoTask = (body: any) => ({
    id: 1,
    status: "NEW",
    timeChunksRequired: 1,
    minChunkSize: 1,
    maxChunkSize: 1,
    timeSchemeId: "ws-1",
    eventCategory: "WORK",
    title: "t",
    ...body,
  });
  const client: ReclaimClient = {
    async get(path) {
      calls.push({ method: "GET", path });
      if (path === "/timeschemes") return HOURS as any;
      if (path === "/timeschemes/fo-1") {
        return { ...HOURS[2], policy: { startOfWeek: "MONDAY", dayHours: { MONDAY: { intervals: [{ start: "10:00:00", end: "13:00:00" }] } } } } as any;
      }
      if (path === "/tasks") return [] as any;
      if (path === "/accounts") return [{ connectedCalendars: [{ id: 9, name: "Focus" }] }] as any;
      if (path === "/events") {
        return [
          { title: "Review", eventStart: "s1", eventEnd: "e1", calendarId: 9, assist: { task: true, taskId: 5 } },
          { title: "Other task", eventStart: "s2", eventEnd: "e2", calendarId: 9, assist: { task: true, taskId: 6 } },
          { title: "Meeting", eventStart: "s3", eventEnd: "e3", calendarId: 9 },
        ] as any;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body) {
      calls.push({ method: "POST", path, body });
      if (path === "/smart-habits") return { lineageId: 77, enabled: true, status: "ACTIVE", activeSeries: body } as any;
      return echoTask(body) as any;
    },
    async patch(path, body) {
      calls.push({ method: "PATCH", path, body });
      return echoTask(body) as any;
    },
    async delete(path) {
      calls.push({ method: "DELETE", path });
      return undefined as any;
    },
  };
  return { client, calls };
}

async function connect(reclaim: ReclaimClient) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(reclaim).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

test("create_task sends Hours, category, and chunked block sizes", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  const result = await client.callTool({
    name: "create_task",
    arguments: {
      title: "Weekly review",
      durationMinutes: 180,
      minBlockMinutes: 45,
      maxBlockMinutes: 45,
      hours: "Focus",
      due: "2026-11-05T13:00:00-05:00",
    },
  });
  assert.equal(result.isError, undefined);
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(post, {
    method: "POST",
    path: "/tasks",
    body: {
      title: "Weekly review",
      timeChunksRequired: 12,
      minChunkSize: 3,
      maxChunkSize: 3,
      timeSchemeId: "fo-1",
      eventCategory: "WORK",
      due: "2026-11-05T18:00:00.000Z",
    },
  });
});

test("Personal Hours make the task PERSONAL unless a category is given", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  await client.callTool({ name: "create_task", arguments: { title: "Errands", durationMinutes: 30, hours: "Personal Hours" } });
  assert.equal((calls.find((c) => c.method === "POST")?.body as any).eventCategory, "PERSONAL");
});

test("update_task patches only the passed fields", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  await client.callTool({ name: "update_task", arguments: { taskId: 42, maxBlockMinutes: 60 } });
  assert.deepEqual(calls.find((c) => c.method === "PATCH"), { method: "PATCH", path: "/tasks/42", body: { maxChunkSize: 4 } });
});

test("bad input comes back as a tool error, not a Reclaim call", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  const result = await client.callTool({ name: "create_task", arguments: { title: "x", durationMinutes: 40 } });
  assert.equal(result.isError, true);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("list_task_blocks returns only task blocks, with calendar names", async () => {
  const { client: reclaim } = fakeReclaim();
  const client = await connect(reclaim);
  const result: any = await client.callTool({ name: "list_task_blocks", arguments: { taskId: 5 } });
  assert.deepEqual(JSON.parse(result.content[0].text), [
    { taskId: 5, title: "Review", start: "s1", end: "e1", calendar: "Focus" },
  ]);
});

test("unknown Hours name lists the available ones", async () => {
  const { client: reclaim } = fakeReclaim();
  const client = await connect(reclaim);
  const result = await client.callTool({ name: "create_task", arguments: { title: "x", durationMinutes: 30, hours: "Gym" } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Focus/);
});

test("create_habit resolves Hours and calendar names", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  const result: any = await client.callTool({
    name: "create_habit",
    arguments: { title: "Review", minMinutes: 45, days: ["MONDAY"], idealTime: "10:00", hours: "Focus" },
  });
  assert.equal(result.isError, undefined);
  const body: any = calls.find((c) => c.path === "/smart-habits")?.body;
  assert.deepEqual(body.organizer, { timePolicyType: "CUSTOM", timeSchemeId: "fo-1" });
  assert.equal(body.calendarId, 9);
  assert.equal(JSON.parse(result.content[0].text).calendar, "Focus");
});

test("create_habit rejects an unknown calendar before calling Reclaim", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  const result = await client.callTool({
    name: "create_habit",
    arguments: { title: "x", minMinutes: 30, days: ["MONDAY"], idealTime: "10:00", hours: "Focus", calendar: "Nope" },
  });
  assert.equal(result.isError, true);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("update_hours merges the changed days and keeps the rest of the policy", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  const result = await client.callTool({ name: "update_hours", arguments: { hours: "Focus", days: { FRIDAY: ["10:00-13:00"] } } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.find((c) => c.method === "PATCH"), {
    method: "PATCH",
    path: "/timeschemes/fo-1",
    body: {
      policy: {
        startOfWeek: "MONDAY",
        dayHours: {
          MONDAY: { intervals: [{ start: "10:00:00", end: "13:00:00" }] },
          FRIDAY: { intervals: [{ start: "10:00:00", end: "13:00:00" }] },
        },
      },
    },
  });
});

test("update_hours rejects a bad window before calling Reclaim", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  const result = await client.callTool({ name: "update_hours", arguments: { hours: "Focus", days: { FRIDAY: ["9-5"] } } });
  assert.equal(result.isError, true);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
});
