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

const EVENTS = [
  { key: "9/taskev1", title: "Review", eventStart: "2026-11-02T15:00:00.000Z", eventEnd: "2026-11-02T15:45:00.000Z", calendarId: 9, assist: { task: true, taskId: 5, pinned: false } },
  { key: "9/taskev2", title: "Other task", eventStart: "s2", eventEnd: "e2", calendarId: 3, assist: { task: true, taskId: 6, pinned: true } },
  { key: "9/habitev1", title: "Walk", eventStart: "2026-11-03T15:00:00.000Z", eventEnd: "2026-11-03T15:30:00.000Z", calendarId: 9, assist: { smartSeries: true, seriesLineageId: 77, pinned: false } },
  { key: "9/meeting1", title: "Meeting", eventStart: "s3", eventEnd: "e3", calendarId: 9 },
];

function fakeReclaim() {
  const calls: { method: string; path: string; body?: unknown; query?: unknown }[] = [];
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
      if (path === "/accounts") return [{ connectedCalendars: [{ id: 9, name: "Focus" }, { id: 3, name: "Personal" }] }] as any;
      if (path === "/events") return EVENTS as any;
      const event = EVENTS.find((e) => path === `/events/${e.key}`);
      if (event) return event as any;
      if (path === "/smart-habits/77") {
        return { lineageId: 77, enabled: true, activeSeries: { title: "Review", calendarId: 9, durationMinMins: 30, durationMaxMins: 60 } } as any;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body, query) {
      calls.push({ method: "POST", path, body, ...(query ? { query } : {}) });
      if (path === "/smart-habits") return { lineageId: 77, enabled: true, status: "ACTIVE", activeSeries: body } as any;
      if (path === "/tasks/at-time") return { task: { ...echoTask(body), id: 5 }, events: [EVENTS[0], EVENTS[2]] } as any;
      return echoTask(body) as any;
    },
    async patch(path, body) {
      calls.push({ method: "PATCH", path, body });
      if (path.startsWith("/smart-habits/")) return { lineageId: 77, activeSeries: body } as any;
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
  await createServer(reclaim, { settleMs: 0 }).connect(serverSide);
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

test("list_blocks returns task and habit blocks with blockIds, filtered by calendar", async () => {
  const { client: reclaim } = fakeReclaim();
  const client = await connect(reclaim);
  const result: any = await client.callTool({ name: "list_blocks", arguments: { calendar: "Focus" } });
  assert.deepEqual(JSON.parse(result.content[0].text), [
    { blockId: "9/taskev1", kind: "task", taskId: 5, title: "Review", start: "2026-11-02T15:00:00.000Z", end: "2026-11-02T15:45:00.000Z", calendar: "Focus", locked: false },
    { blockId: "9/habitev1", kind: "habit", habitId: 77, title: "Walk", start: "2026-11-03T15:00:00.000Z", end: "2026-11-03T15:30:00.000Z", calendar: "Focus", locked: false },
  ]);
});

test("list_blocks filters to one habit", async () => {
  const { client: reclaim } = fakeReclaim();
  const client = await connect(reclaim);
  const result: any = await client.callTool({ name: "list_blocks", arguments: { habitId: 77 } });
  assert.deepEqual(JSON.parse(result.content[0].text).map((b: any) => b.blockId), ["9/habitev1"]);
});

test("lock_block with a start moves a task block, keeping its length, then pins it", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  const result = await client.callTool({ name: "lock_block", arguments: { blockId: "9/taskev1", start: "2026-10-31T10:00:00-04:00" } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.filter((c) => c.method === "POST"), [
    { method: "POST", path: "/planner/event/9/taskev1/move", body: undefined, query: { start: "2026-10-31T14:00:00.000Z", end: "2026-10-31T14:45:00.000Z" } },
    { method: "POST", path: "/planner/event/9/taskev1/pin", body: {} },
  ]);
});

test("lock_block and unlock_block use the habit endpoints for habit blocks", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  await client.callTool({ name: "lock_block", arguments: { blockId: "9/habitev1" } });
  await client.callTool({ name: "unlock_block", arguments: { blockId: "9/habitev1" } });
  assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.path), [
    "/smart-habits/planner/habitev1/lock",
    "/smart-habits/planner/habitev1/unlock",
  ]);
});

test("lock_block with a start only moves a habit block, which Reclaim locks itself", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  await client.callTool({ name: "lock_block", arguments: { blockId: "9/habitev1", start: "2026-11-03T10:30:00-05:00" } });
  assert.deepEqual(calls.filter((c) => c.method === "POST"), [
    { method: "POST", path: "/smart-habits/planner/habitev1/move", body: undefined, query: { start: "2026-11-03T15:30:00.000Z", end: "2026-11-03T16:00:00.000Z" } },
  ]);
});

test("a block action that Reclaim has not applied yet says so", async () => {
  const { client: reclaim } = fakeReclaim();
  const client = await connect(reclaim);
  const result: any = await client.callTool({ name: "lock_block", arguments: { blockId: "9/taskev1" } });
  assert.match(JSON.parse(result.content[0].text).note, /not applied this yet/);
});

test("block tools refuse malformed ids and non-Reclaim events", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  const bad = await client.callTool({ name: "lock_block", arguments: { blockId: "9/../tasks" } });
  const meeting = await client.callTool({ name: "lock_block", arguments: { blockId: "9/meeting1" } });
  assert.equal(bad.isError, true);
  assert.equal(meeting.isError, true);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("skip_habit_block and complete_habit_block act on habit blocks only", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  await client.callTool({ name: "skip_habit_block", arguments: { blockId: "9/habitev1" } });
  await client.callTool({ name: "complete_habit_block", arguments: { blockId: "9/habitev1" } });
  const onTask = await client.callTool({ name: "skip_habit_block", arguments: { blockId: "9/taskev1" } });
  assert.equal(onTask.isError, true);
  assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.path), [
    "/smart-habits/planner/habitev1/skip",
    "/smart-habits/planner/habitev1/done",
  ]);
});

test("create_task with startAt books the first block at that time", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  const result: any = await client.callTool({
    name: "create_task",
    arguments: { title: "Errands", durationMinutes: 30, hours: "Focus", startAt: "2026-10-31T10:00:00-04:00" },
  });
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/tasks/at-time");
  assert.deepEqual(post?.query, { startTime: "2026-10-31T14:00:00.000Z" });
  const body = JSON.parse(result.content[0].text);
  assert.deepEqual(body.blocks.map((b: any) => b.blockId), ["9/taskev1"]);
  assert.match(body.note, /not placed the block yet/);
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

test("update_hours can point the Hours at another calendar", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  await client.callTool({ name: "update_hours", arguments: { hours: "Working Hours", taskCalendar: "Focus" } });
  assert.deepEqual(calls.find((c) => c.method === "PATCH"), { method: "PATCH", path: "/timeschemes/ws-1", body: { taskTargetCalendarId: 9 } });
  const neither = await client.callTool({ name: "update_hours", arguments: { hours: "Focus" } });
  assert.equal(neither.isError, true);
});

test("update_habit patches only the passed fields", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  const result = await client.callTool({ name: "update_habit", arguments: { habitId: 77, days: ["TUESDAY"], idealTime: "11:30" } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.find((c) => c.method === "PATCH"), {
    method: "PATCH",
    path: "/smart-habits/77",
    body: { recurrence: { frequency: "WEEKLY", idealDays: ["TUESDAY"], interval: 1 }, idealTime: "11:30:00" },
  });
});

test("update_habit checks a new minimum against the current maximum", async () => {
  const { client: reclaim, calls } = fakeReclaim();
  const client = await connect(reclaim);
  const result = await client.callTool({ name: "update_habit", arguments: { habitId: 77, minMinutes: 90 } });
  assert.equal(result.isError, true);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
});
