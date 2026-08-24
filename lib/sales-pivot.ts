// Aggregation behind the "Resumen general de ventas" pivot table: won
// opportunities laid out as month-of-close (rows) × sucursal › servicio
// (columns), summing monetary value.
//
// Pure and React-free so it can be asserted by scripts/verify-sales-pivot.ts —
// a silently wrong number here is invisible in the UI, which is exactly the
// class of bug the verify scripts exist for.
import type { Opportunity } from "./types"
import { isWonOpp } from "./opportunity-status"

export const CLOSE_DATE_FIELD = "Fecha de Cierre"
export const SERVICIO_FIELD = "Servicio"

export const NO_SUCURSAL = "Sin sucursal"
export const NO_SERVICIO = "Sin servicio"
export const NO_DATE_KEY = "sin-fecha"
export const NO_DATE_LABEL = "Sin fecha de cierre"
export const TOTAL_KEY = "total"

export interface PivotCell {
  value: number
  oppIds: string[]
}

export interface PivotColumn {
  /**
   * Stable key: `${sucursal}||${servicio}` for cells, `sub||${sucursal}` for
   * subtotals, `total` for the grand-total column.
   */
  key: string
  sucursal: string
  servicio: string
  kind: "cell" | "subtotal" | "total"
}

export interface PivotRow {
  key: string
  label: string
  kind: "month" | "no-date" | "total"
  /** One entry per column, same order and length as `columns`. */
  cells: PivotCell[]
}

export interface SalesPivot {
  columns: PivotColumn[]
  rows: PivotRow[]
  grandTotal: number
}

const MONTHS_ES = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
]

function cfString(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v
  return (s ?? "").trim()
}

/** The opportunity's close date as an ISO string, or undefined if unset. */
export function closeDateOf(opp: Opportunity): string | undefined {
  const raw = cfString(opp.customFieldsResolved?.[CLOSE_DATE_FIELD])
  if (!raw) return undefined
  const t = new Date(raw).getTime()
  return Number.isNaN(t) ? undefined : raw
}

// GHL stores DATE fields at UTC midnight, so the month MUST be read in UTC.
// With a local (America/Mexico_City) reading, a close on the 1st at 00:00Z
// lands on the previous month.
export function monthKeyOf(iso: string): string {
  const d = new Date(iso)
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  return `${d.getUTCFullYear()}-${m}`
}

export function monthLabelOf(key: string): string {
  const [year, month] = key.split("-")
  return `${MONTHS_ES[Number(month) - 1]} ${year}`
}

const cellKey = (sucursal: string, servicio: string) => `${sucursal}||${servicio}`
const subtotalKey = (sucursal: string) => `sub||${sucursal}`

export function buildSalesPivot(
  opps: Opportunity[],
  opts: { sucursalField: string }
): SalesPivot {
  // Wins come from isWonOpp(), the repo's single definition: status "won", or a
  // stage named "Ganado" on an opportunity that is not explicitly lost.
  // Measured against production on 2026-08-04 the strict `status === "won"` rule
  // would select the identical set — 648 in VAEO, 42 in MESH, zero divergence
  // either way — so the shared helper costs nothing here and keeps this table
  // agreeing with every other won-based metric.
  const won = opps.filter(isWonOpp)

  // Pass 1 — bucket every won opp and accumulate the totals that drive ordering.
  type Entry = { rowKey: string; sucursal: string; servicio: string; opp: Opportunity }
  const entries: Entry[] = []
  const sucursalTotals = new Map<string, number>()
  const servicioTotals = new Map<string, number>()
  const pairSeen = new Set<string>()
  const rowKeys = new Set<string>()

  for (const opp of won) {
    const iso = closeDateOf(opp)
    const rowKey = iso ? monthKeyOf(iso) : NO_DATE_KEY
    const sucursal = cfString(opp.customFieldsResolved?.[opts.sucursalField]) || NO_SUCURSAL
    const servicio = cfString(opp.customFieldsResolved?.[SERVICIO_FIELD]) || NO_SERVICIO
    const value = opp.value ?? 0

    entries.push({ rowKey, sucursal, servicio, opp })
    rowKeys.add(rowKey)
    pairSeen.add(cellKey(sucursal, servicio))
    sucursalTotals.set(sucursal, (sucursalTotals.get(sucursal) ?? 0) + value)
    servicioTotals.set(servicio, (servicioTotals.get(servicio) ?? 0) + value)
  }

  // Column order. Sucursales by total desc, "Sin sucursal" last. Inside each
  // one, servicios follow a GLOBAL order (panel-wide total desc) so a column's
  // position means the same thing in every group — that is what makes the
  // groups comparable at a glance — and only the servicios present in that
  // sucursal are rendered. "Sin servicio" always closes a group.
  const byTotalDesc = (totals: Map<string, number>, last: string) =>
    (a: string, b: string) => {
      if (a === last) return 1
      if (b === last) return -1
      const diff = (totals.get(b) ?? 0) - (totals.get(a) ?? 0)
      return diff !== 0 ? diff : a.localeCompare(b, "es")
    }

  const sucursales = [...sucursalTotals.keys()].sort(byTotalDesc(sucursalTotals, NO_SUCURSAL))
  const serviciosGlobal = [...servicioTotals.keys()].sort(byTotalDesc(servicioTotals, NO_SERVICIO))

  const columns: PivotColumn[] = []
  for (const sucursal of sucursales) {
    for (const servicio of serviciosGlobal) {
      if (!pairSeen.has(cellKey(sucursal, servicio))) continue
      columns.push({ key: cellKey(sucursal, servicio), sucursal, servicio, kind: "cell" })
    }
    columns.push({
      key: subtotalKey(sucursal),
      sucursal,
      servicio: "Subtotal",
      kind: "subtotal",
    })
  }
  columns.push({ key: TOTAL_KEY, sucursal: "", servicio: "Total", kind: "total" })

  const columnIndex = new Map(columns.map((c, i) => [c.key, i]))

  // Row order: "Sin fecha de cierre" pinned first, then months ascending.
  const monthKeys = [...rowKeys].filter((k) => k !== NO_DATE_KEY).sort()
  const orderedRowKeys = rowKeys.has(NO_DATE_KEY) ? [NO_DATE_KEY, ...monthKeys] : monthKeys

  const emptyCells = () => columns.map(() => ({ value: 0, oppIds: [] as string[] }))
  const rowCells = new Map<string, PivotCell[]>(
    orderedRowKeys.map((k) => [k, emptyCells()])
  )
  const totalCells = emptyCells()

  // Pass 2 — fill the cell, its sucursal subtotal, and both total lanes.
  const add = (cells: PivotCell[], index: number, value: number, id: string) => {
    cells[index].value += value
    cells[index].oppIds.push(id)
  }

  for (const e of entries) {
    const cells = rowCells.get(e.rowKey)
    if (!cells) continue
    const value = e.opp.value ?? 0
    const targets = [
      columnIndex.get(cellKey(e.sucursal, e.servicio)),
      columnIndex.get(subtotalKey(e.sucursal)),
      columnIndex.get(TOTAL_KEY),
    ]
    for (const i of targets) {
      if (i === undefined) continue
      add(cells, i, value, e.opp.id)
      add(totalCells, i, value, e.opp.id)
    }
  }

  const rows: PivotRow[] = orderedRowKeys.map((key) => ({
    key,
    label: key === NO_DATE_KEY ? NO_DATE_LABEL : monthLabelOf(key),
    kind: key === NO_DATE_KEY ? "no-date" : "month",
    cells: rowCells.get(key)!,
  }))

  if (rows.length > 0) {
    rows.push({ key: TOTAL_KEY, label: "Total", kind: "total", cells: totalCells })
  }

  const totalIndex = columnIndex.get(TOTAL_KEY)!
  return { columns, rows, grandTotal: totalCells[totalIndex]?.value ?? 0 }
}
