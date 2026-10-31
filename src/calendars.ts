import type { ReclaimClient } from "./reclaim.ts";

export async function loadCalendarNames(reclaim: ReclaimClient): Promise<Map<number, string>> {
  const accounts = await reclaim.get<any[]>("/accounts");
  return new Map(accounts.flatMap((a) => (a.connectedCalendars ?? []).map((c: any) => [c.id, c.name] as [number, string])));
}

export function resolveCalendar(names: Map<number, string>, ref: string): number {
  const wanted = ref.trim().toLowerCase();
  const matches = [...names].filter(([id, name]) => String(id) === ref || name.toLowerCase() === wanted);
  if (matches.length === 1) return matches[0][0];
  const all = [...names.values()].map((n) => `"${n}"`).join(", ");
  throw new Error(`Calendar "${ref}" ${matches.length ? "matches more than one" : "matches none"} of: ${all}`);
}
