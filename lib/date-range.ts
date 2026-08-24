import { endOfDay, startOfDay, subDays, subMonths } from "date-fns"

export type DateFilterPreset = "week" | "month" | "3m" | "6m" | "all" | "custom"

export interface DateFilter {
  preset: DateFilterPreset
  // Only used when preset === "custom"
  from?: Date
  to?: Date
}

export interface ResolvedDateRange {
  from: Date
  to: Date
}

export function resolveDateRange(
  filter: DateFilter,
  now: Date = new Date()
): ResolvedDateRange | null {
  const to = endOfDay(now)

  switch (filter.preset) {
    case "week":
      return { from: startOfDay(subDays(now, 7)), to }
    case "month":
      return { from: startOfDay(subDays(now, 30)), to }
    case "3m":
      return { from: startOfDay(subMonths(now, 3)), to }
    case "6m":
      return { from: startOfDay(subMonths(now, 6)), to }
    case "custom":
      if (!filter.from) return null
      return {
        from: startOfDay(filter.from),
        to: endOfDay(filter.to ?? filter.from),
      }
    case "all":
    default:
      return null
  }
}

// Items with a missing or unparseable date are kept rather than dropped.
export function filterByDateRange<T>(
  items: T[],
  getDate: (item: T) => string | undefined,
  range: ResolvedDateRange | null
): T[] {
  if (!range) return items

  const fromMs = range.from.getTime()
  const toMs = range.to.getTime()

  return items.filter((item) => {
    const iso = getDate(item)
    if (!iso) return true
    const t = new Date(iso).getTime()
    if (Number.isNaN(t)) return true
    return t >= fromMs && t <= toMs
  })
}
