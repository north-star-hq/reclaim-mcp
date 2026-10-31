import assert from "node:assert/strict";
import { test } from "node:test";
import { applyWindows, parseWindows } from "../src/hours.ts";

const EXISTING = {
  MONDAY: { intervals: [{ start: "10:00:00", end: "13:00:00" }], startOfDay: "10:00:00" },
  THURSDAY: { intervals: [{ start: "10:00:00", end: "13:00:00" }] },
};

test("adding a day leaves the other days untouched", () => {
  const result = applyWindows(EXISTING, { FRIDAY: ["10:00-13:00"] });
  assert.deepEqual(result.FRIDAY, { intervals: [{ start: "10:00:00", end: "13:00:00" }] });
  assert.equal(result.MONDAY, EXISTING.MONDAY);
  assert.equal(result.THURSDAY, EXISTING.THURSDAY);
});

test("an empty list removes the day", () => {
  const result = applyWindows(EXISTING, { THURSDAY: [] });
  assert.equal("THURSDAY" in result, false);
  assert.equal("MONDAY" in result, true);
});

test("several windows in a day are sorted", () => {
  assert.deepEqual(parseWindows("MONDAY", ["14:00-15:30", "09:00-12:00"]), [
    { start: "09:00:00", end: "12:00:00" },
    { start: "14:00:00", end: "15:30:00" },
  ]);
});

test("bad, backwards and overlapping windows are rejected", () => {
  assert.throws(() => parseWindows("MONDAY", ["10am-1pm"]), /not a window/);
  assert.throws(() => parseWindows("MONDAY", ["13:00-10:00"]), /ends before it starts/);
  assert.throws(() => parseWindows("MONDAY", ["10:00-12:00", "11:00-13:00"]), /overlap/);
  assert.throws(() => applyWindows(EXISTING, {}), /at least one day/);
});
