import { useEffect, useMemo, useState, type CSSProperties } from "react"
import { CalendarDays, ChevronLeft, ChevronRight, List } from "lucide-react"
import { apiGet, type OutlineNode, type Workspace } from "./api"
import { calendarDate, calendarDateKey, calendarMonthDays } from "./calendarDates"
import { holidayText, lunarText } from "./chinaCalendar"
import { useChinaCalendar } from "./useChinaCalendar"
import "./calendar.css"

const monthFormat = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" })
const dayFormat = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
const shortDayFormat = new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric" })
const agendaDayFormat = new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", year: "numeric" })
const hues = ["blue", "purple", "green", "orange", "red"]
function workspaceColor(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `var(--text-color-${hues[hash % hues.length]})`
}

export function Calendar({ workspaces, search, onOpen }: {
  workspaces: Workspace[]
  search: string
  onOpen: (node: OutlineNode) => void
}) {
  const [today, setToday] = useState(() => calendarDateKey(new Date()))
  const [selectedDay, setSelectedDay] = useState(today)
  const [month, setMonth] = useState(() => calendarDate(today))
  const [view, setView] = useState<"month" | "agenda">("month")
  const [workspaceFilter, setWorkspaceFilter] = useState("")
  const [nodes, setNodes] = useState<OutlineNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  const chinaCalendar = useChinaCalendar()

  useEffect(() => {
    let request = 0
    const refresh = async () => {
      const current = ++request
      setToday(calendarDateKey(new Date()))
      try {
        const result = await apiGet<OutlineNode[]>("/api/calendar")
        if (current !== request) return
        setNodes(result)
        setError("")
      } catch (cause) {
        if (current === request) setError(cause instanceof Error ? cause.message : "Could not load the calendar")
      } finally {
        if (current === request) setLoading(false)
      }
    }
    void refresh()
    const visibleRefresh = () => { if (document.visibilityState === "visible") void refresh() }
    const events = ["outliner-data-changed", "outliner-sync", "focus"]
    events.forEach(event => window.addEventListener(event, visibleRefresh))
    document.addEventListener("visibilitychange", visibleRefresh)
    const timer = window.setInterval(visibleRefresh, 60_000)
    return () => {
      request += 1
      window.clearInterval(timer)
      events.forEach(event => window.removeEventListener(event, visibleRefresh))
      document.removeEventListener("visibilitychange", visibleRefresh)
    }
  }, [retry])

  const workspaceNames = useMemo(() => new Map(workspaces.map(w => [w.id, w.name])), [workspaces])
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return nodes.filter(node => node.dueDate && (!workspaceFilter || node.workspaceId === workspaceFilter)
      && (!query || `${node.title}\n${node.body}\n${workspaceNames.get(node.workspaceId) ?? ""}`.toLowerCase().includes(query)))
  }, [nodes, workspaceFilter, search, workspaceNames])
  const byDate = useMemo(() => {
    const groups = new Map<string, OutlineNode[]>()
    for (const node of filtered) {
      const key = node.dueDate!
      const group = groups.get(key) ?? []
      group.push(node)
      groups.set(key, group)
    }
    return groups
  }, [filtered])
  const days = useMemo(() => calendarMonthDays(month), [month])
  const monthKey = calendarDateKey(month).slice(0, 7)
  const selectedNodes = byDate.get(selectedDay) ?? []
  const selectedChinaDay = chinaCalendar.byDate.get(selectedDay)
  const selectDay = (key: string) => {
    setSelectedDay(key)
    if (!key.startsWith(monthKey)) setMonth(calendarDate(key))
  }
  const moveMonth = (offset: number) => {
    const next = new Date(month.getFullYear(), month.getMonth() + offset, 1, 12)
    setMonth(next)
    setSelectedDay(calendarDateKey(next))
  }
  const eventList = (items: OutlineNode[]) => items.map(node => (
    <button className={`calendarAgendaEvent${node.done ? " isDone" : ""}`} key={node.id} type="button"
      title={`${node.title || "Untitled"}\n${workspaceNames.get(node.workspaceId) ?? "Workspace"}${node.done ? " · Completed" : ""}`}
      style={{ "--event-color": workspaceColor(node.workspaceId) } as CSSProperties} onClick={() => onOpen(node)}>
      <span className="calendarEventTime">All day</span>
      <span className="calendarEventContent"><strong title={node.title || "Untitled"}>{node.title || "Untitled"}</strong>
        <small title={workspaceNames.get(node.workspaceId) ?? "Workspace"}>{workspaceNames.get(node.workspaceId) ?? "Workspace"}{node.done ? " · Completed" : ""}</small></span>
    </button>
  ))

  return (
    <section className="calendarPage" aria-label="Calendar">
      <header className="calendarHeader">
        <div>
          <h1>{view === "month" ? monthFormat.format(month) : "Your schedule"}</h1>
          {view === "agenda" && <p>{filtered.length} scheduled items across all dates</p>}
        </div>
        <div className="calendarHeaderActions">
          <select aria-label="Filter calendar by workspace" value={workspaceFilter} onChange={event => setWorkspaceFilter(event.target.value)}>
            <option value="">All workspaces</option>
            {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <button className="calendarTodayButton" type="button" onClick={() => { const key = calendarDateKey(new Date()); setToday(key); setSelectedDay(key); setMonth(calendarDate(key)); setView("month") }}>Today</button>
          <div className="calendarViewSwitch" aria-label="Calendar view">
            <button type="button" aria-pressed={view === "month"} onClick={() => setView("month")}><CalendarDays size={15} /> Month</button>
            <button type="button" aria-pressed={view === "agenda"} onClick={() => setView("agenda")}><List size={15} /> Schedule</button>
          </div>
        </div>
      </header>
      {error && <div className="calendarError" role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
      {chinaCalendar.unavailable.length > 0 && <div className="calendarFeedNotice" role="status">
        <span>{chinaCalendar.unavailable.map(source => source === "holiday" ? "节假日" : "农历").join("、")}暂时无法更新，已有缓存仍可使用</span>
        <button type="button" onClick={chinaCalendar.retry}>重试</button>
      </div>}
      {loading ? <p className="calendarEmpty" role="status">Loading your schedule…</p> : view === "month" ? (
        <div className="calendarLayout">
          <div className="calendarMonth">
            <div className="calendarWeekdays">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, index) => <div className="calendarWeekday" key={day}>
              {index === 0 && <button className="calendarMonthArrow previous" type="button" aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft size={16} /></button>}
              <span>{day}</span>
              {index === 6 && <button className="calendarMonthArrow next" type="button" aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight size={16} /></button>}
            </div>)}</div>
            <div className="calendarDays">
              {days.map(date => {
                const key = calendarDateKey(date)
                const events = byDate.get(key) ?? []
                const chinaDay = chinaCalendar.byDate.get(key)
                const holiday = chinaDay?.holidays.find(item => item.kind === "workday") ?? chinaDay?.holidays[0]
                const isWeekend = date.getDay() === 0 || date.getDay() === 6
                return <div key={key} className={`calendarDay${date.getMonth() !== month.getMonth() ? " outsideMonth" : ""}${key === selectedDay ? " selectedDay" : ""}`}
                  onClick={event => {
                    if ((event.target as HTMLElement).closest("button")) return
                    selectDay(key)
                  }}>
                  <button className={`calendarDayNumber${key === today ? " isToday" : ""}`} type="button"
                    aria-label={`${dayFormat.format(date)}, ${events.length} scheduled items`} aria-pressed={key === selectedDay}
                    aria-current={key === today ? "date" : undefined} onClick={() => selectDay(key)}>{date.getDate()}</button>
                  {(holiday || isWeekend) && <span className={`calendarHolidayBadge ${holiday?.kind ?? "holiday"}`}
                    title={holiday?.summary ?? "周末休息"}>{holiday?.kind === "workday" ? "班" : "休"}</span>}
                  {chinaDay && <div className="calendarAlmanac">
                    {chinaDay.lunar && <span className="calendarLunar" title={lunarText(chinaDay.lunar.summary).full}>{lunarText(chinaDay.lunar.summary).short}</span>}
                    {chinaDay.holidays.map((holiday, index) => <span key={index} className={`calendarHolidayLabel ${holiday.kind}`}
                      title={holiday.description}>{holidayText(holiday.summary)}</span>)}
                  </div>}
                  <div className="calendarDayEvents">{events.slice(0, 3).map(node => <button type="button" key={node.id}
                    className={`calendarChip${node.done ? " isDone" : ""}`} style={{ "--event-color": workspaceColor(node.workspaceId) } as CSSProperties}
                    title={`${node.title || "Untitled"} · ${workspaceNames.get(node.workspaceId) ?? "Workspace"}`} onClick={() => onOpen(node)}>{node.title || "Untitled"}</button>)}</div>
                  {events.length > 0 && <button type="button" className={`calendarMore${events.length <= 3 ? " mobileOnly" : ""}`}
                    aria-label={`View ${events.length} items for ${dayFormat.format(date)}`} onClick={() => selectDay(key)}>
                    <span className="calendarDesktopCount">{events.length > 3 ? `+${events.length - 3} more` : ""}</span>
                    <span className="calendarMobileCount">{events.length} {events.length === 1 ? "item" : "items"}</span>
                  </button>}
                </div>
              })}
            </div>
          </div>
          <aside className="calendarDayPanel" aria-label="Selected day schedule">
            <h2>{shortDayFormat.format(calendarDate(selectedDay))}</h2>
            {selectedChinaDay && <div className="calendarChinaDetails">
              {selectedChinaDay.lunar && <span title={selectedChinaDay.lunar.description}>农历 {lunarText(selectedChinaDay.lunar.summary).full.replace(/\s+\d{4}年$/, "")}</span>}
              {selectedChinaDay.holidays.map((holiday, index) => <span key={index} className={`calendarHolidayLabel ${holiday.kind}`} title={holiday.description}>
                {holidayText(holiday.summary)} · {holiday.kind === "workday" ? "补班" : "放假"}
              </span>)}
            </div>}
            <p>{selectedNodes.length} {selectedNodes.length === 1 ? "item" : "items"} · All day</p>
            <div className="calendarDayItems">
              {selectedNodes.length ? eventList(selectedNodes) : <div className="calendarEmpty"><CalendarDays size={28} /><strong>A little room in your day</strong><span>No scheduled items for this date</span></div>}
            </div>
          </aside>
        </div>
      ) : <div className="calendarAgenda">
        {[...byDate.keys()].sort().map(date => <section key={date} className="calendarAgendaGroup"><h2>{agendaDayFormat.format(calendarDate(date))}{date === today && <span>Today</span>}</h2>
          {chinaCalendar.byDate.get(date)?.lunar && <p className="calendarAgendaLunar">农历 {lunarText(chinaCalendar.byDate.get(date)!.lunar!.summary).full}</p>}
          {eventList(byDate.get(date)!)}</section>)}
        {!filtered.length && <div className="calendarEmpty"><CalendarDays size={32} /><strong>No scheduled items</strong><span>{search || workspaceFilter ? "Try another search or workspace" : "Add a date to an outline to see it here"}</span></div>}
      </div>}
    </section>
  )
}
