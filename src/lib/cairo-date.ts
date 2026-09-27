/** Calendar date shown to staff in Egypt, independent of browser or server time zone. */
export function cairoDateKey(instant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Add calendar days to today's Cairo date, including across daylight saving changes. */
export function cairoDatePlusDays(days: number, instant: Date = new Date()): string {
  const date = new Date(`${cairoDateKey(instant)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
