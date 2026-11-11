import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { holidayText, loadChinaCalendar, lunarText, parseChinaCalendar } from "../src/web/chinaCalendar"

const wrap = (events: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}\r\nEND:VCALENDAR`
const holiday = wrap(`BEGIN:VEVENT
UID:new-year
DTSTART;VALUE=DATE:20260101
DTEND;VALUE=DATE:20260104
SUMMARY:「元旦 假期」 第1天/共3天
DESCRIPTION:First line\\nSecond\\, line
END:VEVENT
BEGIN:VEVENT
UID:makeup
DTSTART;TZID=Asia/Shanghai:20260104T090000
DTEND;TZID=Asia/Shanghai:20260104T180000
SUMMARY:「元旦 补班」 第1天/共1天
BEGIN:VALARM
SUMMARY:Ignore nested alarm
END:VALARM
END:VEVENT`)
const lunar = wrap(`BEGIN:VEVENT
UID:lunar-new-year
DTSTART;VALUE=DATE:20260217
DTEND;VALUE=DATE:20260218
SUMMARY:『正月 初一
  2026年』
END:VEVENT`)

describe("Chinese calendar feeds", () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value) })
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it("honors exclusive all-day ends and keeps Chinese workdays on their original date", () => {
    const events = parseChinaCalendar(holiday, "holiday")
    expect(events.map(event => [event.date, event.kind])).toEqual([
      ["2026-01-01", "holiday"], ["2026-01-02", "holiday"], ["2026-01-03", "holiday"], ["2026-01-04", "workday"]
    ])
    expect(events[0].description).toBe("First line\nSecond, line")
    expect(events[3].summary).toContain("元旦 补班")
    expect(holidayText(events[3].summary)).toBe("元旦")
  })

  it("unfolds lunar text, keeps leap months and uses the month name on the first day", () => {
    expect(lunarText(parseChinaCalendar(lunar, "lunar")[0].summary)).toEqual({ full: "正月 初一 2026年", short: "正月" })
    expect(lunarText("『闰六月 初一 2025年』").short).toBe("闰六月")
    expect(lunarText("『冬月 廿九 2026年』").short).toBe("廿九")
  })

  it("ignores cancelled entries and deduplicates repeated events", () => {
    const event = "BEGIN:VEVENT\nUID:same\nDTSTART;VALUE=DATE:20260101\nSUMMARY:元旦\nEND:VEVENT"
    expect(parseChinaCalendar(wrap(`${event}\n${event}\nBEGIN:VEVENT\nSTATUS:CANCELLED\nEND:VEVENT`), "holiday")).toHaveLength(1)
  })

  it("deduplicates downloads and uses the fresh local cache", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(holiday))
    vi.stubGlobal("fetch", fetcher)
    const [first, second] = await Promise.all([loadChinaCalendar("holiday"), loadChinaCalendar("holiday")])
    expect(first.entries).toHaveLength(4)
    expect(second).toEqual(first)
    await loadChinaCalendar("holiday")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("retains the last valid feed when an expired cache cannot be refreshed", async () => {
    localStorage.setItem("openoutliner.china-calendar:lunar:v1", JSON.stringify({ text: lunar, fetchedAt: 0 }))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>not a calendar</html>")))
    const result = await loadChinaCalendar("lunar")
    expect(result.stale).toBe(true)
    expect(result.entries[0].date).toBe("2026-02-17")
    expect(JSON.parse(localStorage.getItem("openoutliner.china-calendar:lunar:v1")!).text).toBe(lunar)
  })

  it("reports missing data when the first fetch fails, but tolerates unavailable storage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    await expect(loadChinaCalendar("holiday")).rejects.toThrow("offline")
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("full") } })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(lunar)))
    expect((await loadChinaCalendar("lunar")).entries).toHaveLength(1)
  })
})
