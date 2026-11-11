import { useEffect, useMemo, useState } from "react"
import { loadChinaCalendar, readChinaCalendarCache, type ChinaCalendarEntry, type ChinaCalendarSource } from "./chinaCalendar"

const sources: ChinaCalendarSource[] = ["holiday", "lunar"]
export function useChinaCalendar() {
  const [entries, setEntries] = useState(() => Object.fromEntries(sources.map(source =>
    [source, readChinaCalendarCache(source)?.entries ?? []])) as Record<ChinaCalendarSource, ChinaCalendarEntry[]>)
  const [unavailable, setUnavailable] = useState<ChinaCalendarSource[]>([])
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    const refresh = () => {
      for (const source of sources) {
        void loadChinaCalendar(source).then(result => {
          if (!active) return
          setEntries(current => ({ ...current, [source]: result.entries }))
          setUnavailable(current => result.stale ? [...new Set([...current, source])] : current.filter(item => item !== source))
        }).catch(() => {
          if (active) setUnavailable(current => [...new Set([...current, source])])
        })
      }
    }
    refresh()
    window.addEventListener("online", refresh)
    window.addEventListener("focus", refresh)
    const timer = window.setInterval(refresh, 60 * 60 * 1000)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener("online", refresh)
      window.removeEventListener("focus", refresh)
    }
  }, [retry])
  const byDate = useMemo(() => {
    const days = new Map<string, { lunar?: ChinaCalendarEntry; holidays: ChinaCalendarEntry[] }>()
    for (const item of [...entries.lunar, ...entries.holiday]) {
      const day = days.get(item.date) ?? { holidays: [] }
      if (item.kind === "lunar") day.lunar = item
      else day.holidays.push(item)
      days.set(item.date, day)
    }
    return days
  }, [entries])
  return { byDate, unavailable, retry: () => setRetry(value => value + 1) }
}
