import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { summarizeHabit, toHabitPayload, WEEKDAYS } from "./habits.ts";
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

type TaskInput = Omit<TaskFields, "hoursId"> & { hours?: string };

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createServer(reclaim: ReclaimClient): McpServer {
  const server = new McpServer({ name: "reclaim", version: "0.1.0" });

  const loadHours = () => reclaim.get<Hours[]>("/timeschemes");
  const hoursMap = (all: Hours[]) => new Map(all.map((h) => [h.id, h]));

  async function loadCalendarNames(): Promise<Map<number, string>> {
    const accounts = await reclaim.get<any[]>("/accounts");
    return new Map(accounts.flatMap((a) => (a.connectedCalendars ?? []).map((c: any) => [c.id, c.name] as [number, string])));
  }

  function resolveCalendar(names: Map<number, string>, ref: string): number {
    const wanted = ref.trim().toLowerCase();
    const matches = [...names].filter(([id, name]) => String(id) === ref || name.toLowerCase() === wanted);
    if (matches.length === 1) return matches[0][0];
    const all = [...names.values()].map((n) => `"${n}"`).join(", ");
    throw new Error(`Calendar "${ref}" ${matches.length ? "matches more than one" : "matches none"} of: ${all}`);
  }

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
        "Change the weekly windows of a Reclaim Hours. Only the days you pass change. " +
        "Reclaim then reschedules the tasks and habits that use these Hours.",
      inputSchema: z.object({
        hours: z.string().describe("Hours to change, by title or id from list_hours"),
        days: z.object(dayWindowsShape),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ hours: hoursRef, days }) => {
      const target = resolveHours(await loadHours(), hoursRef);
      const current = await reclaim.get<any>(`/timeschemes/${target.id}`);
      const dayHours = applyWindows(current.policy?.dayHours ?? {}, days);
      await reclaim.patch(`/timeschemes/${target.id}`, { policy: { ...current.policy, dayHours } });
      return text(summarizeHours(await reclaim.get<any>(`/timeschemes/${target.id}`)));
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "List Reclaim tasks. Active tasks only unless includeDone is true.",
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
        "Without block sizes Reclaim applies the account defaults (60 to 120 minutes), so pass them for shorter tasks.",
      inputSchema: z.object(taskFieldShape),
    },
    async (input) => {
      const { payload, hoursById } = await buildPayload(input);
      payload.eventCategory ??= "WORK";
      const created = await reclaim.post<ApiTask>("/tasks", payload);
      return text(summarizeTask(created, hoursById));
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
    "list_task_blocks",
    {
      title: "List scheduled task blocks",
      description:
        "List the calendar blocks Reclaim has scheduled for tasks, with the calendar each one is on. Optionally filter to one task.",
      inputSchema: z.object({
        taskId: z.number().int().optional(),
        days: z.number().int().min(1).max(60).optional().describe("How many days ahead to look, default 14"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ taskId, days = 14 }) => {
      const start = new Date();
      const end = new Date(start.getTime() + (days + 1) * 86_400_000);
      const isoDate = (d: Date) => d.toISOString().slice(0, 10);
      const [events, calendarNames] = await Promise.all([
        reclaim.get<any[]>("/events", { start: isoDate(start), end: isoDate(end), allConnected: true }),
        loadCalendarNames(),
      ]);
      return text(
        events
          .filter((e) => e.assist?.task && (taskId === undefined || e.assist.taskId === taskId))
          .map((e) => ({
            taskId: e.assist.taskId,
            title: e.title,
            start: e.eventStart,
            end: e.eventEnd,
            calendar: calendarNames.get(e.calendarId) ?? e.calendarId,
          })),
      );
    },
  );

  server.registerTool(
    "list_habits",
    {
      title: "List habits",
      description: "List Reclaim habits and whether each is enabled.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [habits, calendarNames] = await Promise.all([reclaim.get<any[]>("/smart-habits"), loadCalendarNames()]);
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
        days: z.array(z.enum(WEEKDAYS)).min(1).describe("Days of the week to schedule one block on"),
        idealTime: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .describe("Preferred start time, HH:MM, in the account time zone"),
        hours: z.string().describe("Hours to schedule within, by title or id from list_hours"),
        calendar: z.string().optional().describe("Calendar name; defaults to the Hours' task calendar"),
        category: z.enum(["WORK", "PERSONAL"]).optional().describe("Defaults to the Hours' category, otherwise WORK"),
        starting: z.iso.date().optional().describe("First date it may schedule, YYYY-MM-DD"),
      }),
    },
    async ({ hours: hoursRef, calendar, ...rest }) => {
      const [allHours, calendarNames] = await Promise.all([loadHours(), loadCalendarNames()]);
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
