import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  DAY_MS,
  DEFAULT_SETTLE_MS,
  isoDate,
  isReclaimBlock,
  loadBlock,
  settledBlock,
  settledTaskBlocks,
  summarizeBlock,
} from "./blocks.ts";
import { loadCalendarNames, resolveCalendar } from "./calendars.ts";
import { summarizeHabit, toHabitPatch, toHabitPayload, WEEKDAYS } from "./habits.ts";
import { applyWindows, summarizeHours } from "./hours.ts";
import type { ReclaimClient } from "./reclaim.ts";
import { type ApiTask, type Hours, resolveHours, summarizeTask, type TaskFields, toTaskPayload } from "./tasks.ts";

const ACTIVE_STATUSES = new Set(["NEW", "SCHEDULED", "IN_PROGRESS"]);

const minutes = z.number().int().positive().multipleOf(15);
const dateTime = z.iso
  .datetime({ offset: true })
  .describe("ISO 8601 date-time with a UTC offset, e.g. 2026-11-05T17:00:00-05:00");

const taskFieldShape = {
  title: z.string().min(1),
  durationMinutes: minutes.describe("Total time the task needs, in minutes (multiple of 15)"),
  minBlockMinutes: minutes.optional().describe("Shortest calendar block Reclaim may schedule, in minutes"),
  maxBlockMinutes: minutes.optional().describe("Longest calendar block Reclaim may schedule, in minutes"),
  hours: z
    .string()
    .optional()
    .describe("Hours to schedule within, by title or id from list_hours. The Hours decide which calendar the blocks land on."),
  category: z.enum(["WORK", "PERSONAL"]).optional().describe("Defaults to the chosen Hours' category, otherwise WORK"),
  due: dateTime.optional(),
  notBefore: dateTime.optional().describe("Do not schedule before this time"),
  priority: z.enum(["P1", "P2", "P3", "P4"]).optional().describe("P1 is critical, P4 is low"),
  notes: z.string().optional(),
  alwaysPrivate: z.boolean().optional().describe("Hide the title on shared calendars"),
};

const habitDays = z.array(z.enum(WEEKDAYS)).min(1).describe("Days of the week to schedule one block on");
const idealTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe("Preferred start time, HH:MM, in the account time zone");
const blockId = z.string().describe("blockId from list_blocks");

type TaskInput = Omit<TaskFields, "hoursId"> & { hours?: string };

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createServer(reclaim: ReclaimClient, options: { settleMs?: number } = {}): McpServer {
  const server = new McpServer({ name: "reclaim", version: "0.1.0" });
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;

  const loadHours = () => reclaim.get<Hours[]>("/timeschemes");
  const hoursMap = (all: Hours[]) => new Map(all.map((h) => [h.id, h]));

  async function buildPayload(input: TaskInput) {
    const { hours: hoursRef, ...rest } = input;
    const all = await loadHours();
    const fields: TaskFields = { ...rest };
    if (hoursRef !== undefined) {
      const hours = resolveHours(all, hoursRef);
      fields.hoursId = hours.id;
      fields.category ??= hours.taskCategory ?? undefined;
    }
    return { payload: toTaskPayload(fields), hoursById: hoursMap(all) };
  }

  server.registerTool(
    "list_hours",
    {
      title: "List Hours",
      description:
        "List the Reclaim Hours (time schemes) with their weekly windows and the calendar tasks scheduled in them land on.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const all = await reclaim.get<any[]>("/timeschemes");
      return text(all.map(summarizeHours));
    },
  );

  const dayWindows = z
    .array(z.string())
    .optional()
    .describe('Windows in the account time zone, like ["10:00-13:00"]. An empty list removes the day.');
  const dayWindowsShape = Object.fromEntries(WEEKDAYS.map((day) => [day, dayWindows])) as Record<
    (typeof WEEKDAYS)[number],
    typeof dayWindows
  >;

  server.registerTool(
    "update_hours",
    {
      title: "Update Hours",
      description:
        "Change a Reclaim Hours: its weekly windows (only the days you pass change) and/or the calendar its tasks land on. " +
        "Reclaim then reschedules the tasks and habits that use these Hours.",
      inputSchema: z.object({
        hours: z.string().describe("Hours to change, by title or id from list_hours"),
        days: z.object(dayWindowsShape).optional(),
        taskCalendar: z.string().optional().describe("Calendar that tasks in these Hours land on, by name"),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ hours: hoursRef, days, taskCalendar }) => {
      if (days === undefined && taskCalendar === undefined) throw new Error("Pass days, taskCalendar, or both");
      const target = resolveHours(await loadHours(), hoursRef);
      const patch: Record<string, unknown> = {};
      if (days !== undefined) {
        const current = await reclaim.get<any>(`/timeschemes/${target.id}`);
        patch.policy = { ...current.policy, dayHours: applyWindows(current.policy?.dayHours ?? {}, days) };
      }
      if (taskCalendar !== undefined) {
        patch.taskTargetCalendarId = resolveCalendar(await loadCalendarNames(reclaim), taskCalendar);
      }
      await reclaim.patch(`/timeschemes/${target.id}`, patch);
      return text(summarizeHours(await reclaim.get<any>(`/timeschemes/${target.id}`)));
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "List Reclaim tasks, including whether Reclaim flags each as at risk of missing its due time. Active tasks only unless includeDone is true.",
      inputSchema: z.object({ includeDone: z.boolean().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ includeDone }) => {
      const [tasks, all] = await Promise.all([reclaim.get<ApiTask[]>("/tasks"), loadHours()]);
      const byId = hoursMap(all);
      return text(tasks.filter((t) => includeDone || ACTIVE_STATUSES.has(t.status)).map((t) => summarizeTask(t, byId)));
    },
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description: "Get one Reclaim task by id.",
      inputSchema: z.object({ taskId: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ taskId }) => {
      const [task, all] = await Promise.all([reclaim.get<ApiTask>(`/tasks/${taskId}`), loadHours()]);
      return text(summarizeTask(task, hoursMap(all)));
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create a Reclaim task. Reclaim schedules it as named calendar blocks within the chosen Hours, before the due time. " +
        "Pass startAt to put the first block at an exact time instead. " +
        "Without block sizes Reclaim applies the account defaults (60 to 120 minutes), so pass them for shorter tasks.",
      inputSchema: z.object({
        ...taskFieldShape,
        startAt: dateTime.optional().describe("Schedule the first block at exactly this time"),
      }),
    },
    async ({ startAt, ...input }) => {
      const { payload, hoursById } = await buildPayload(input);
      payload.eventCategory ??= "WORK";
      if (startAt === undefined) {
        const created = await reclaim.post<ApiTask>("/tasks", payload);
        return text(summarizeTask(created, hoursById));
      }
      const created = await reclaim.post<{ task: ApiTask }>("/tasks/at-time", payload, {
        startTime: new Date(startAt).toISOString(),
      });
      const placed = await settledTaskBlocks(reclaim, created.task.id, startAt, settleMs);
      return text({ task: summarizeTask(created.task, hoursById), ...placed });
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description: "Change fields on an existing Reclaim task. Only the fields you pass are changed.",
      inputSchema: z.object({ taskId: z.number().int(), ...z.object(taskFieldShape).partial().shape }),
    },
    async ({ taskId, ...input }) => {
      const { payload, hoursById } = await buildPayload(input);
      const updated = await reclaim.patch<ApiTask>(`/tasks/${taskId}`, payload);
      return text(summarizeTask(updated, hoursById));
    },
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description: "Mark a Reclaim task done. Its remaining scheduled blocks are removed.",
      inputSchema: z.object({ taskId: z.number().int() }),
      annotations: { idempotentHint: true },
    },
    async ({ taskId }) => {
      await reclaim.post(`/planner/done/task/${taskId}`);
      const [task, all] = await Promise.all([reclaim.get<ApiTask>(`/tasks/${taskId}`), loadHours()]);
      return text(summarizeTask(task, hoursMap(all)));
    },
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete task",
      description: "Permanently delete a Reclaim task and its scheduled blocks.",
      inputSchema: z.object({ taskId: z.number().int() }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ taskId }) => {
      await reclaim.delete(`/tasks/${taskId}`);
      return text({ deleted: taskId });
    },
  );

  server.registerTool(
    "list_blocks",
    {
      title: "List scheduled blocks",
      description:
        "List the calendar blocks Reclaim has scheduled for tasks and habits: time, calendar, and whether each is locked. " +
        "Each block's blockId is what lock_block, unlock_block, skip_habit_block and complete_habit_block take.",
      inputSchema: z.object({
        taskId: z.number().int().optional(),
        habitId: z.number().int().optional(),
        calendar: z.string().optional().describe("Only blocks on this calendar, by name"),
        days: z.number().int().min(1).max(60).optional().describe("How many days ahead to look, default 14"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ taskId, habitId, calendar, days = 14 }) => {
      const now = Date.now();
      const [events, calendarNames] = await Promise.all([
        reclaim.get<any[]>("/events", { start: isoDate(now), end: isoDate(now + (days + 1) * DAY_MS), allConnected: true }),
        loadCalendarNames(reclaim),
      ]);
      const calendarId = calendar === undefined ? undefined : resolveCalendar(calendarNames, calendar);
      return text(
        events
          .filter(isReclaimBlock)
          .filter((e) => taskId === undefined || e.assist.taskId === taskId)
          .filter((e) => habitId === undefined || e.assist.seriesLineageId === habitId)
          .filter((e) => calendarId === undefined || e.calendarId === calendarId)
          .map((e) => summarizeBlock(e, calendarNames)),
      );
    },
  );

  server.registerTool(
    "lock_block",
    {
      title: "Lock block",
      description:
        "Lock a task or habit block so Reclaim stops moving it. Pass start to move it there first (it keeps its length).",
      inputSchema: z.object({ blockId, start: dateTime.optional().describe("New start time for the block") }),
      annotations: { idempotentHint: true },
    },
    async ({ blockId: id, start }) => {
      const { calendarId, eventId, event, isHabit } = await loadBlock(reclaim, id);
      if (start === undefined) {
        if (isHabit) await reclaim.post(`/smart-habits/planner/${eventId}/lock`);
        else await reclaim.post(`/planner/event/${calendarId}/${eventId}/pin`, {});
        return text(await settledBlock(reclaim, id, (b) => b.locked, settleMs));
      }
      const length = Date.parse(event.eventEnd) - Date.parse(event.eventStart);
      const window = {
        start: new Date(start).toISOString(),
        end: new Date(Date.parse(start) + length).toISOString(),
      };
      if (isHabit) {
        // Reclaim locks a habit block when it moves it; a lock call right after the move kept the block from moving.
        await reclaim.post(`/smart-habits/planner/${eventId}/move`, undefined, window);
      } else {
        await reclaim.post(`/planner/event/${calendarId}/${eventId}/move`, undefined, window);
        await reclaim.post(`/planner/event/${calendarId}/${eventId}/pin`, {});
      }
      return text(await settledBlock(reclaim, id, (b) => b.locked && Date.parse(b.start) === Date.parse(start), settleMs));
    },
  );

  server.registerTool(
    "unlock_block",
    {
      title: "Unlock block",
      description: "Unlock a task or habit block so Reclaim can move it again.",
      inputSchema: z.object({ blockId }),
      annotations: { idempotentHint: true },
    },
    async ({ blockId: id }) => {
      const { calendarId, eventId, isHabit } = await loadBlock(reclaim, id);
      if (isHabit) await reclaim.post(`/smart-habits/planner/${eventId}/unlock`);
      else await reclaim.post(`/planner/event/${calendarId}/${eventId}/unpin`, {});
      return text(await settledBlock(reclaim, id, (b) => !b.locked, settleMs));
    },
  );

  for (const [name, action, description] of [
    ["skip_habit_block", "skip", "Skip one habit block (this occurrence only); the habit keeps running."],
    [
      "complete_habit_block",
      "done",
      "Mark one habit block done (this occurrence only). Reclaim ends the block at the current time, so use it for a block " +
        "in progress or already past; to drop a future occurrence, use skip_habit_block.",
    ],
  ] as const) {
    server.registerTool(
      name,
      { title: description.split(" (")[0], description, inputSchema: z.object({ blockId }) },
      async ({ blockId: id }) => {
        const { eventId, isHabit } = await loadBlock(reclaim, id);
        if (!isHabit) throw new Error(`${id} is a task block, not a habit block`);
        await reclaim.post(`/smart-habits/planner/${eventId}/${action}`);
        return text({ blockId: id, [action === "skip" ? "skipped" : "done"]: true });
      },
    );
  }

  server.registerTool(
    "list_habits",
    {
      title: "List habits",
      description: "List Reclaim habits and whether each is enabled.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [habits, calendarNames] = await Promise.all([reclaim.get<any[]>("/smart-habits"), loadCalendarNames(reclaim)]);
      return text(habits.map((h) => summarizeHabit(h, calendarNames)));
    },
  );

  server.registerTool(
    "create_habit",
    {
      title: "Create habit",
      description:
        "Create a weekly Reclaim habit: one block on each chosen day, scheduled within the chosen Hours near the ideal time. " +
        "It lands on the Hours' task calendar unless another calendar is named.",
      inputSchema: z.object({
        title: z.string().min(1),
        minMinutes: z.number().int().positive().describe("Shortest acceptable block, in minutes"),
        maxMinutes: z.number().int().positive().optional().describe("Longest block, in minutes; defaults to minMinutes"),
        days: habitDays,
        idealTime,
        hours: z.string().describe("Hours to schedule within, by title or id from list_hours"),
        calendar: z.string().optional().describe("Calendar name; defaults to the Hours' task calendar"),
        category: z.enum(["WORK", "PERSONAL"]).optional().describe("Defaults to the Hours' category, otherwise WORK"),
        starting: z.iso.date().optional().describe("First date it may schedule, YYYY-MM-DD"),
      }),
    },
    async ({ hours: hoursRef, calendar, ...rest }) => {
      const [allHours, calendarNames] = await Promise.all([loadHours(), loadCalendarNames(reclaim)]);
      const payload = toHabitPayload({
        ...rest,
        hours: resolveHours(allHours, hoursRef),
        calendarId: calendar === undefined ? undefined : resolveCalendar(calendarNames, calendar),
      });
      const created = await reclaim.post<any>("/smart-habits", payload);
      return text(summarizeHabit(created, calendarNames));
    },
  );

  server.registerTool(
    "update_habit",
    {
      title: "Update habit",
      description:
        "Change an existing Reclaim habit. Only the fields you pass change; days replaces the whole list. " +
        "Changing Hours does not move the habit to another calendar unless you also pass calendar.",
      inputSchema: z.object({
        habitId: z.number().int(),
        title: z.string().min(1).optional(),
        minMinutes: z.number().int().positive().optional(),
        maxMinutes: z.number().int().positive().optional(),
        days: habitDays.optional(),
        idealTime: idealTime.optional(),
        hours: z.string().optional().describe("Hours to schedule within, by title or id from list_hours"),
        calendar: z.string().optional().describe("Calendar to move the habit to, by name"),
        category: z.enum(["WORK", "PERSONAL"]).optional(),
        starting: z.iso.date().optional().describe("First date it may schedule, YYYY-MM-DD"),
      }),
    },
    async ({ habitId, hours: hoursRef, calendar, ...rest }) => {
      const [current, allHours, calendarNames] = await Promise.all([
        reclaim.get<any>(`/smart-habits/${habitId}`),
        loadHours(),
        loadCalendarNames(reclaim),
      ]);
      const series = current.activeSeries ?? current.series;
      const patch = toHabitPatch(
        {
          ...rest,
          hours: hoursRef === undefined ? undefined : resolveHours(allHours, hoursRef),
          calendarId: calendar === undefined ? undefined : resolveCalendar(calendarNames, calendar),
        },
        { minMinutes: series?.durationMinMins, maxMinutes: series?.durationMaxMins },
      );
      const updated = await reclaim.patch<any>(`/smart-habits/${habitId}`, patch);
      return text(summarizeHabit(updated, calendarNames));
    },
  );

  server.registerTool(
    "set_habit_enabled",
    {
      title: "Enable or disable habit",
      description:
        "Turn a Reclaim habit on or off. Turning one off removes its upcoming calendar events. Confirm with the user before calling.",
      inputSchema: z.object({ habitId: z.number().int(), enabled: z.boolean() }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ habitId, enabled }) => {
      if (enabled) await reclaim.post(`/smart-habits/${habitId}/enable`);
      else await reclaim.delete(`/smart-habits/${habitId}/disable`);
      return text({ habitId, enabled });
    },
  );

  return server;
}
