import { describe, expect, it } from "vitest"
import { calendarDate, calendarDateKey, calendarMonthDays } from "../src/web/calendarDates"

describe("calendar dates", () => {
  it("lays out Monday-first grids across leap days and year boundaries", () => {
    const february = calendarMonthDays(calendarDate("2024-02-15")).map(calendarDateKey)
    expect(february).toHaveLength(42)
    expect(february[0]).toBe("2024-01-29")
    expect(february).toContain("2024-02-29")
    expect(new Set(february).size).toBe(42)
    const january = calendarMonthDays(calendarDate("2027-01-01")).map(calendarDateKey)
    expect(january[0]).toBe("2026-12-28")
    expect(january[41]).toBe("2027-02-07")
  })

  it("retains local dates across daylight saving transitions", () => {
    for (const key of ["2026-03-08", "2026-11-01", "2024-02-29"]) {
      expect(calendarDateKey(calendarDate(key))).toBe(key)
    }
  })
})
