// Use local calendar dates, avoiding UTC conversion and DST arithmetic.
export function calendarDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function calendarDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(year, month - 1, day, 12)
}

export function calendarMonthDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12)
  const offset = (first.getDay() + 6) % 7
  return Array.from({ length: 42 }, (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + index, 12))
}
