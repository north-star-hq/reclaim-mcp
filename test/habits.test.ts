import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeHabit, toHabitPayload } from "../src/habits.ts";
import type { Hours } from "../src/tasks.ts";

const FOCUS: Hours = {
  id: "fo-1",
  title: "Focus",
  policyType: "CUSTOM",
  taskCategory: "WORK",
  taskTargetCalendar: { id: 9, name: "Focus" },
};
const PERSONAL: Hours = { id: "ps-1", title: "Personal Hours", policyType: "PERSONAL", taskCategory: "PERSONAL" };

test("a work habit on custom Hours lands on the Hours' task calendar", () => {
  assert.deepEqual(
    toHabitPayload({
      title: "Review",
      minMinutes: 45,
      days: ["MONDAY", "THURSDAY"],
      idealTime: "10:00",
      hours: FOCUS,
      starting: "2026-11-08",
    }),
    {
      title: "Review",
      type: "HABIT",
      enabled: true,
      recurrence: { frequency: "WEEKLY", idealDays: ["MONDAY", "THURSDAY"], interval: 1 },
      idealTime: "10:00:00",
      durationMinMins: 45,
      durationMaxMins: 45,
      eventType: "SOLO_WORK",
      defenseAggression: "DEFAULT",
      organizer: { timePolicyType: "CUSTOM", timeSchemeId: "fo-1" },
      calendarId: 9,
      starting: "2026-11-08",
    },
  );
});

test("Personal Hours make a PERSONAL habit; an explicit calendar wins", () => {
  const payload = toHabitPayload({
    title: "Walk",
    minMinutes: 30,
    maxMinutes: 60,
    days: ["SATURDAY"],
    idealTime: "08:30",
    hours: PERSONAL,
    calendarId: 3,
  });
  assert.equal(payload.eventType, "PERSONAL");
  assert.equal(payload.calendarId, 3);
  assert.equal(payload.durationMaxMins, 60);
  assert.equal("starting" in payload, false);
});

test("minimum longer than maximum is rejected", () => {
  assert.throws(
    () => toHabitPayload({ title: "x", minMinutes: 60, maxMinutes: 30, days: ["MONDAY"], idealTime: "09:00", hours: PERSONAL }),
    /longer than maximum/,
  );
});

test("habit summaries name the calendar", () => {
  const summary = summarizeHabit(
    {
      lineageId: 5,
      enabled: true,
      status: "ACTIVE",
      activeSeries: { title: "Review", calendarId: 9, durationMinMins: 45, durationMaxMins: 45, recurrence: { frequency: "WEEKLY", idealDays: ["MONDAY"] } },
    },
    new Map([[9, "Focus"]]),
  );
  assert.equal(summary.calendar, "Focus");
  assert.deepEqual(summary.days, ["MONDAY"]);
});
