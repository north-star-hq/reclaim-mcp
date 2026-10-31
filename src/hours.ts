import type { Weekday } from "./habits.ts";

type DayHours = { intervals: { start: string; end: string }[] } & Record<string, unknown>;

const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

export function parseWindows(day: string, windows: string[]): { start: string; end: string }[] {
  const parsed = windows.map((w) => {
    const m = w.trim().match(WINDOW);
    if (!m) throw new Error(`${day}: "${w}" is not a window like 10:00-13:00`);
    const start = `${m[1]}:${m[2]}`;
    const end = `${m[3]}:${m[4]}`;
    if (end <= start) throw new Error(`${day}: "${w}" ends before it starts`);
    return { start, end };
  });
  parsed.sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].start < parsed[i - 1].end) throw new Error(`${day}: windows overlap`);
  }
  return parsed.map(({ start, end }) => ({ start: `${start}:00`, end: `${end}:00` }));
}

export function applyWindows(
  existing: Record<string, DayHours>,
  changes: Partial<Record<Weekday, string[]>>,
): Record<string, DayHours> {
  const days = Object.entries(changes).filter(([, windows]) => windows !== undefined) as [Weekday, string[]][];
  if (days.length === 0) throw new Error("Pass at least one day to change");
  const result = { ...existing };
  for (const [day, windows] of days) {
    if (windows.length === 0) delete result[day];
    else result[day] = { intervals: parseWindows(day, windows) };
  }
  return result;
}

export function summarizeHours(h: any) {
  return {
    id: h.id,
    title: h.title,
    category: h.taskCategory ?? undefined,
    taskCalendar: h.taskTargetCalendar?.name ?? undefined,
    usedFor: h.features,
    weekly: Object.fromEntries(
      Object.entries(h.policy?.dayHours ?? {}).map(([day, value]: [string, any]) => [
        day,
        (value?.intervals ?? []).map((i: any) => `${i.start}-${i.end}`).join(", "),
      ]),
    ),
  };
}
