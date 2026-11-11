import ICAL from "ical.js"

export const chinaCalendarSources = {
  holiday: "https://yangh9.github.io/ChinaCalendar/cal_holiday.ics",
  lunar: "https://yangh9.github.io/ChinaCalendar/cal_lunar.ics"
} as const
export type ChinaCalendarSource = keyof typeof chinaCalendarSources
export interface ChinaCalendarEntry {
  date: string
  summary: string
  description: string
  kind: "holiday" | "workday" | "lunar"
}
const DAY = 86_400_000
const CACHE_AGE = 12 * 60 * 60 * 1000
const cacheKey = (source: ChinaCalendarSource) => `openoutliner.china-calendar:${source}:v1`

/** These feeds publish concrete dates, in the Chinese calendar's date domain.
 * Never convert an all-day date or Shanghai workday to the viewer's timezone. */
export function parseChinaCalendar(text: string, source: ChinaCalendarSource): ChinaCalendarEntry[] {
  const calendar = new ICAL.Component(ICAL.parse(text))
  if (calendar.name !== "vcalendar") throw new Error("Invalid calendar feed")
  const entries: ChinaCalendarEntry[] = []
  const seen = new Set<string>()
  for (const component of calendar.getAllSubcomponents("vevent")) {
    if (component.getFirstPropertyValue("status") === "CANCELLED") continue
    const event = new ICAL.Event(component)
    if (event.isRecurring() || component.hasProperty("recurrence-id")) {
      throw new Error("Expected dated entries in the Chinese calendar feed")
    }
    const start = event.startDate
    const end = event.endDate
    if (!start || !event.summary) throw new Error("Incomplete calendar event")
    const from = Date.UTC(start.year, start.month - 1, start.day)
    let until = end ? Date.UTC(end.year, end.month - 1, end.day) : from
    // DTEND is exclusive. A timed event ending during a day includes that day.
    if (end && !end.isDate && (end.hour || end.minute || end.second)) until += DAY
    if (until < from || until - from > 366 * DAY) throw new Error("Invalid calendar date range")
    until = Math.max(from + DAY, until)
    const kind = source === "lunar" ? "lunar" : /补班|上班|工作日/.test(event.summary) ? "workday" : "holiday"
    for (let time = from; time < until; time += DAY) {
      const date = new Date(time).toISOString().slice(0, 10)
      const id = `${event.uid || event.summary}:${date}`
      if (seen.has(id)) continue
      seen.add(id)
      entries.push({ date, summary: event.summary, description: event.description || "", kind })
    }
  }
  if (!entries.length) throw new Error("Empty calendar feed")
  return entries.sort((a, b) => a.date.localeCompare(b.date))
}

export function lunarText(summary: string) {
  const full = summary.replace(/[『』]/g, "").trim()
  const match = full.match(/^(\S+)\s+(\S+)\s+\d{4}年$/)
  return { full, short: match ? match[2] === "初一" ? match[1] : match[2] : full }
}

export function holidayText(summary: string) {
  return summary.match(/「(.+?)\s+(?:假期|补班)」/)?.[1] ?? summary
}

export function readChinaCalendarCache(source: ChinaCalendarSource) {
  try {
    const saved = JSON.parse(localStorage.getItem(cacheKey(source)) || "null")
    if (!saved || typeof saved.text !== "string" || typeof saved.fetchedAt !== "number") return null
    return { entries: parseChinaCalendar(saved.text, source), fetchedAt: saved.fetchedAt }
  } catch { return null }
}

const pending = new Map<ChinaCalendarSource, Promise<{ entries: ChinaCalendarEntry[]; stale: boolean }>>()
export function loadChinaCalendar(source: ChinaCalendarSource) {
  const existing = pending.get(source)
  if (existing) return existing
  const request = (async () => {
    const cached = readChinaCalendarCache(source)
    if (cached && Date.now() - cached.fetchedAt >= 0 && Date.now() - cached.fetchedAt < CACHE_AGE) {
      return { entries: cached.entries, stale: false }
    }
    try {
      const response = await fetch(chinaCalendarSources[source], {
        credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) throw new Error(`Calendar feed returned ${response.status}`)
      const text = await response.text()
      if (text.length > 2_000_000) throw new Error("Calendar feed is too large")
      const entries = parseChinaCalendar(text, source)
      try { localStorage.setItem(cacheKey(source), JSON.stringify({ text, fetchedAt: Date.now() })) } catch { /* Keep usable data if storage is full. */ }
      return { entries, stale: false }
    } catch (error) {
      if (cached) return { entries: cached.entries, stale: true }
      throw error
    }
  })().finally(() => pending.delete(source))
  pending.set(source, request)
  return request
}
