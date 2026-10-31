import assert from "node:assert/strict";
import { test } from "node:test";
import { type Hours, minutesToChunks, resolveHours, summarizeTask, toTaskPayload } from "../src/tasks.ts";

const HOURS: Hours[] = [
  { id: "ws-1", title: "Working Hours", taskCategory: "WORK" },
  { id: "ps-1", title: "Personal Hours", taskCategory: "PERSONAL" },
  { id: "fo-1", title: "Focus", taskCategory: "WORK" },
  { id: "fo-2", title: "Focus Meetings" },
];

test("minutes convert to 15-minute chunks", () => {
  assert.equal(minutesToChunks(45), 3);
  assert.equal(minutesToChunks(180), 12);
  assert.throws(() => minutesToChunks(40), /multiple of 15/);
  assert.throws(() => minutesToChunks(0), /multiple of 15/);
});

test("fixed 45-minute blocks for a 180-minute task", () => {
  const payload = toTaskPayload({ title: "x", durationMinutes: 180, minBlockMinutes: 45, maxBlockMinutes: 45 });
  assert.deepEqual(payload, { title: "x", timeChunksRequired: 12, minChunkSize: 3, maxChunkSize: 3 });
});

test("block sizes must be consistent", () => {
  assert.throws(() => toTaskPayload({ minBlockMinutes: 60, maxBlockMinutes: 45 }), /longer than maximum/);
  assert.throws(() => toTaskPayload({ durationMinutes: 30, minBlockMinutes: 45 }), /longer than the task/);
});

test("date-times are sent as UTC", () => {
  const payload = toTaskPayload({ due: "2026-11-05T17:00:00-05:00", notBefore: "2026-11-01T09:00:00+02:00" });
  assert.equal(payload.due, "2026-11-05T22:00:00.000Z");
  assert.equal(payload.snoozeUntil, "2026-11-01T07:00:00.000Z");
});

test("only passed fields are included", () => {
  assert.deepEqual(toTaskPayload({ hoursId: "fo-1", category: "WORK" }), { timeSchemeId: "fo-1", eventCategory: "WORK" });
  assert.deepEqual(toTaskPayload({}), {});
});

test("Hours resolve by id, exact title, or unique partial title", () => {
  assert.equal(resolveHours(HOURS, "ps-1").title, "Personal Hours");
  assert.equal(resolveHours(HOURS, "focus").id, "fo-1");
  assert.equal(resolveHours(HOURS, "personal").id, "ps-1");
  assert.equal(resolveHours(HOURS, "meetings").id, "fo-2");
});

test("Hours lookup fails loudly when ambiguous or missing", () => {
  assert.throws(() => resolveHours(HOURS, "hours"), /more than one/);
  assert.throws(() => resolveHours(HOURS, "gym"), /matches none.*"Focus"/);
});

test("task summaries report minutes and the Hours title", () => {
  const summary = summarizeTask(
    {
      id: 7,
      title: "Review",
      status: "SCHEDULED",
      eventCategory: "WORK",
      timeChunksRequired: 12,
      timeChunksRemaining: 9,
      minChunkSize: 3,
      maxChunkSize: 3,
      timeSchemeId: "fo-1",
      notes: "",
      atRisk: true,
    },
    new Map(HOURS.map((h) => [h.id, h])),
  );
  assert.equal(summary.hours, "Focus");
  assert.equal(summary.atRisk, true);
  assert.equal(summary.durationMinutes, 180);
  assert.equal(summary.remainingMinutes, 135);
  assert.equal(summary.minBlockMinutes, 45);
  assert.equal(summary.notes, undefined);
});

test("eventColor is sent only when passed, and a null color reads back as unset", () => {
  assert.deepEqual(toTaskPayload({ eventColor: "PEACOCK" }), { eventColor: "PEACOCK" });
  assert.equal("eventColor" in toTaskPayload({ title: "x" }), false);
  const base = {
    id: 1,
    title: "t",
    status: "NEW",
    eventCategory: "WORK" as const,
    timeChunksRequired: 1,
    minChunkSize: 1,
    maxChunkSize: 1,
    timeSchemeId: "ws-1",
  };
  const byId = new Map(HOURS.map((h) => [h.id, h]));
  assert.equal(summarizeTask({ ...base, eventColor: "BASIL" }, byId).eventColor, "BASIL");
  assert.equal(summarizeTask({ ...base, eventColor: null }, byId).eventColor, undefined);
});
