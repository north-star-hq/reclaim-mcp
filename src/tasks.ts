// Reclaim counts task time in 15-minute chunks.
export const CHUNK_MINUTES = 15;

export type Category = "WORK" | "PERSONAL";
export type Priority = "P1" | "P2" | "P3" | "P4";

// The EventColor enum in Reclaim's OpenAPI spec: https://api.app.reclaim.ai/swagger/reclaim-api-0.1.yml
export const EVENT_COLORS = [
  "NONE",
  "LAVENDER",
  "SAGE",
  "GRAPE",
  "FLAMINGO",
  "BANANA",
  "TANGERINE",
  "PEACOCK",
  "GRAPHITE",
  "BLUEBERRY",
  "BASIL",
  "TOMATO",
] as const;
export type EventColor = (typeof EVENT_COLORS)[number];

export interface Hours {
  id: string;
  title: string;
  status?: string;
  policyType?: string;
  taskCategory?: Category | null;
  taskTargetCalendar?: { id?: number; name?: string } | null;
  features?: string[];
}

export interface ApiTask {
  id: number;
  title: string;
  notes?: string;
  status: string;
  eventCategory: Category;
  timeChunksRequired: number;
  timeChunksRemaining?: number;
  minChunkSize: number;
  maxChunkSize: number;
  timeSchemeId: string;
  due?: string | null;
  snoozeUntil?: string | null;
  priority?: Priority;
  alwaysPrivate?: boolean;
  atRisk?: boolean;
  eventColor?: EventColor | null;
}

export interface TaskFields {
  title?: string;
  notes?: string;
  durationMinutes?: number;
  minBlockMinutes?: number;
  maxBlockMinutes?: number;
  category?: Category;
  hoursId?: string;
  due?: string;
  notBefore?: string;
  priority?: Priority;
  alwaysPrivate?: boolean;
  eventColor?: EventColor;
}

export function minutesToChunks(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes % CHUNK_MINUTES !== 0) {
    throw new Error(`${minutes} minutes is not a positive multiple of ${CHUNK_MINUTES}`);
  }
  return minutes / CHUNK_MINUTES;
}

export function chunksToMinutes(chunks: number): number {
  return chunks * CHUNK_MINUTES;
}

export function toTaskPayload(fields: TaskFields): Record<string, unknown> {
  const { durationMinutes, minBlockMinutes, maxBlockMinutes } = fields;
  if (minBlockMinutes !== undefined && maxBlockMinutes !== undefined && minBlockMinutes > maxBlockMinutes) {
    throw new Error(`Minimum block (${minBlockMinutes} min) is longer than maximum block (${maxBlockMinutes} min)`);
  }
  if (durationMinutes !== undefined && minBlockMinutes !== undefined && minBlockMinutes > durationMinutes) {
    throw new Error(`Minimum block (${minBlockMinutes} min) is longer than the task (${durationMinutes} min)`);
  }

  const payload: Record<string, unknown> = {};
  if (fields.title !== undefined) payload.title = fields.title;
  if (fields.notes !== undefined) payload.notes = fields.notes;
  if (durationMinutes !== undefined) payload.timeChunksRequired = minutesToChunks(durationMinutes);
  if (minBlockMinutes !== undefined) payload.minChunkSize = minutesToChunks(minBlockMinutes);
  if (maxBlockMinutes !== undefined) payload.maxChunkSize = minutesToChunks(maxBlockMinutes);
  if (fields.category !== undefined) payload.eventCategory = fields.category;
  if (fields.hoursId !== undefined) payload.timeSchemeId = fields.hoursId;
  if (fields.due !== undefined) payload.due = toUtcIso(fields.due);
  if (fields.notBefore !== undefined) payload.snoozeUntil = toUtcIso(fields.notBefore);
  if (fields.priority !== undefined) payload.priority = fields.priority;
  if (fields.alwaysPrivate !== undefined) payload.alwaysPrivate = fields.alwaysPrivate;
  if (fields.eventColor !== undefined) payload.eventColor = fields.eventColor;
  return payload;
}

function toUtcIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date-time: ${value}`);
  return date.toISOString();
}

export function resolveHours(all: Hours[], ref: string): Hours {
  const byId = all.find((h) => h.id === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const exact = all.filter((h) => h.title.trim().toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const partial = all.filter((h) => h.title.toLowerCase().includes(wanted));
  if (exact.length === 0 && partial.length === 1) return partial[0];
  const names = all.map((h) => `"${h.title}"`).join(", ");
  const problem = exact.length > 1 || partial.length > 1 ? "matches more than one" : "matches none";
  throw new Error(`Hours "${ref}" ${problem} of: ${names}. Pass the exact title or id.`);
}

export function summarizeTask(task: ApiTask, hoursById: Map<string, Hours>) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    atRisk: task.atRisk,
    category: task.eventCategory,
    hours: hoursById.get(task.timeSchemeId)?.title ?? task.timeSchemeId,
    durationMinutes: chunksToMinutes(task.timeChunksRequired),
    remainingMinutes: task.timeChunksRemaining === undefined ? undefined : chunksToMinutes(task.timeChunksRemaining),
    minBlockMinutes: chunksToMinutes(task.minChunkSize),
    maxBlockMinutes: chunksToMinutes(task.maxChunkSize),
    due: task.due ?? undefined,
    notBefore: task.snoozeUntil ?? undefined,
    priority: task.priority,
    alwaysPrivate: task.alwaysPrivate,
    eventColor: task.eventColor ?? undefined,
    notes: task.notes ? task.notes : undefined,
  };
}
