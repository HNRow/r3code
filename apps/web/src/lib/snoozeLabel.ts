import { msg, t } from "gt-react";

// Snooze presets are assembled from these parts in client-runtime, so the catalog needs them.
void [
  msg("hour"),
  msg("hours"),
  msg("minute"),
  msg("minutes"),
  msg("day"),
  msg("days"),
  msg("week"),
  msg("weeks"),
  msg("Today"),
  msg("Tomorrow"),
  msg("This morning"),
  msg("This afternoon"),
  msg("This evening"),
  msg("Next week"),
];

// 星期名保持英文作为查表键，渲染时再走 m() 取当前语言。
const DAY_NAMES: Readonly<Record<string, string>> = {
  sunday: "Sunday",
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
};

/** Snooze presets are built in client-runtime as English, so the render side resolves them. */
export function translateSnoozeLabel(label: string, m: (text: string) => string): string {
  // "In 5 minutes" / "In 1 hour"：数字动态，用带变量的模板翻译语序。
  const inMatch = /^In (\d+) (\w+)$/.exec(label);
  if (inMatch) {
    const unit = m(inMatch[2]!);
    return t`In ${inMatch[1]} ${unit}`;
  }
  if (/^Next (?:week|month)$/.test(label)) return m(label);
  const nextDay = /^Next (\w+)$/.exec(label);
  if (nextDay) {
    const day = m(DAY_NAMES[nextDay[1]!.toLowerCase()] ?? nextDay[1]!);
    return t`Next ${day}`;
  }
  const day = DAY_NAMES[label.toLowerCase()];
  return day ? m(day) : m(label);
}
