import type { Category, Hours } from "./tasks.ts";

export const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface HabitFields {
  title: string;
  minMinutes: number;
  maxMinutes?: number;
  days: Weekday[];
  idealTime: string;
  hours: Hours;
  calendarId?: number;
  category?: Category;
  starting?: string;
}

export function toHabitPayload(fields: HabitFields): Record<string, unknown> {
  const maxMinutes = fields.maxMinutes ?? fields.minMinutes;
  if (fields.minMinutes > maxMinutes) {
    throw new Error(`Minimum (${fields.minMinutes} min) is longer than maximum (${maxMinutes} min)`);
  }
  const category = fields.category ?? fields.hours.taskCategory ?? "WORK";
  const calendarId = fields.calendarId ?? fields.hours.taskTargetCalendar?.id;
  return {
    title: fields.title,
    type: "HABIT",
    enabled: true,
    recurrence: { frequency: "WEEKLY", idealDays: fields.days, interval: 1 },
    idealTime: `${fields.idealTime}:00`,
    durationMinMins: fields.minMinutes,
    durationMaxMins: maxMinutes,
    eventType: category === "PERSONAL" ? "PERSONAL" : "SOLO_WORK",
    defenseAggression: "DEFAULT",
    organizer: { timePolicyType: fields.hours.policyType, timeSchemeId: fields.hours.id },
    ...(calendarId === undefined ? {} : { calendarId }),
    ...(fields.starting === undefined ? {} : { starting: fields.starting }),
  };
}

export function summarizeHabit(habit: any, calendarNames: Map<number, string>) {
  const series = habit.activeSeries ?? habit.series;
  const calendarId = series?.calendarId ?? habit.calendarId;
  return {
    id: habit.lineageId,
    title: series?.title,
    enabled: habit.enabled,
    status: habit.status,
    minMinutes: series?.durationMinMins,
    maxMinutes: series?.durationMaxMins,
    idealTime: series?.idealTime,
    days: series?.recurrence?.idealDays,
    frequency: series?.recurrence?.frequency,
    starting: series?.starting,
    timezone: series?.timezone?.id,
    calendar: calendarNames.get(calendarId) ?? calendarId,
  };
}
