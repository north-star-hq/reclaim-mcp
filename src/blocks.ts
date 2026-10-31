import { loadCalendarNames } from "./calendars.ts";
import { type ReclaimClient, ReclaimApiError } from "./reclaim.ts";

export const DAY_MS = 86_400_000;
export const DEFAULT_SETTLE_MS = 20_000;
const POLL_MS = 2_500;

export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface Block {
  blockId: string;
  kind: "habit" | "task";
  taskId?: number;
  habitId?: number;
  title: string;
  start: string;
  end: string;
  calendar: string | number;
  locked: boolean;
}

export function parseBlockId(id: string): { calendarId: number; eventId: string } {
  const slash = id.indexOf("/");
  const calendarId = Number(id.slice(0, slash));
  const eventId = id.slice(slash + 1);
  if (slash < 1 || !Number.isInteger(calendarId) || !/^[A-Za-z0-9_-]+$/.test(eventId)) {
    throw new Error(`"${id}" is not a blockId from list_blocks`);
  }
  return { calendarId, eventId };
}

export function isReclaimBlock(event: any): boolean {
  return Boolean(event?.assist?.task || event?.assist?.smartSeries);
}

export function summarizeBlock(event: any, calendarNames: Map<number, string>): Block {
  return {
    blockId: event.key ?? `${event.calendarId}/${event.eventId}`,
    kind: event.assist?.smartSeries ? "habit" : "task",
    taskId: event.assist?.taskId,
    habitId: event.assist?.seriesLineageId,
    title: event.title,
    start: event.eventStart,
    end: event.eventEnd,
    calendar: calendarNames.get(event.calendarId) ?? event.calendarId,
    locked: Boolean(event.assist?.pinned),
  };
}

export async function loadBlock(reclaim: ReclaimClient, id: string) {
  const { calendarId, eventId } = parseBlockId(id);
  const event = await reclaim.get<any>(`/events/${calendarId}/${eventId}`);
  if (!isReclaimBlock(event)) {
    throw new Error(`${id} is not a Reclaim task or habit block`);
  }
  return { calendarId, eventId, event, isHabit: Boolean(event.assist.smartSeries) };
}

// Reclaim applies planner actions in the background, usually within 5 to 15 seconds.
export async function settledBlock(
  reclaim: ReclaimClient,
  id: string,
  done: (block: Block) => boolean,
  settleMs: number = DEFAULT_SETTLE_MS,
) {
  const { calendarId, eventId } = parseBlockId(id);
  const calendarNames = await loadCalendarNames(reclaim);
  const deadline = Date.now() + settleMs;
  for (;;) {
    const event = await reclaim.get<any>(`/events/${calendarId}/${eventId}`).catch((error) => {
      if (error instanceof ReclaimApiError && error.status === 404) return null;
      throw error;
    });
    if (event === null) return { blockId: id, note: "The block has a new id now; run list_blocks to see it." };
    const block = summarizeBlock(event, calendarNames);
    if (done(block)) return block;
    if (Date.now() >= deadline) {
      return { ...block, note: "Reclaim has not applied this yet; check list_blocks in a few seconds." };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export async function settledTaskBlocks(
  reclaim: ReclaimClient,
  taskId: number,
  startAt: string,
  settleMs: number = DEFAULT_SETTLE_MS,
) {
  const calendarNames = await loadCalendarNames(reclaim);
  const day = Date.parse(startAt);
  const range = { start: isoDate(day - DAY_MS), end: isoDate(day + 2 * DAY_MS), allConnected: true };
  const deadline = Date.now() + settleMs;
  for (;;) {
    const events = await reclaim.get<any[]>("/events", range);
    const blocks = events.filter((e) => e.assist?.taskId === taskId).map((e) => summarizeBlock(e, calendarNames));
    if (blocks.some((b) => Date.parse(b.start) === day)) return { blocks };
    if (Date.now() >= deadline) {
      return { blocks, note: "Reclaim has not placed the block yet; check list_blocks in a few seconds." };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
