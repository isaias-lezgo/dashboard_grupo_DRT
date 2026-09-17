// Agregación detrás de "Leads creados por día".
//
// El universo son TODAS las oportunidades del embudo, con y sin asesor: es el
// complemento de "Leads sin asesor por semana", no su subconjunto. Aquí la pregunta
// es cuánto entra cada día, no qué pasa con lo que nadie tomó.
//
// Puro y sin React, igual que lib/assignment-funnel.ts y por la misma razón: un
// día corrido de más o de menos se ve idéntico a uno bien en la UI. Vive bajo
// scripts/verify-leads-per-day.ts.
//
// La frontera de día se calcula SIEMPRE en America/Mexico_City. `createdAt`
// viene en UTC y el servidor de Vercel también corre en UTC; con
// `new Date().getDate()` un lead de las 22:00 hora de México se contaría al día
// siguiente y el pico de una campaña se leería un día tarde.
import type { Opportunity } from "./types"
import { localDay } from "./meta-attribution"
import { NO_DATE_KEY, NO_DATE_LABEL } from "./opportunity-breakdown"

const MONTHS_ES_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]

export interface LeadsDayRow {
  /** `YYYY-MM-DD` en hora de México, o NO_DATE_KEY para la fila sin fecha. */
  key: string
  /** Etiqueta corta del eje: `14 sep`. */
  label: string
  /** Etiqueta larga del tooltip: `14 sep 2026`. */
  longLabel: string
  count: number
  /** Ids del día, para el drill-down. */
  ids: string[]
}

export interface LeadsDaySummary {
  /** Todos los leads del periodo, incluidos los sin fecha. */
  total: number
  /** Días entre el primero y el último con registro, huecos incluidos. */
  days: number
  /** Leads por día sobre `days`; 0 si no hay días. */
  perDay: number
  /** El día con más leads, o null si todo está en cero. */
  peak: LeadsDayRow | null
  /** Leads sin `createdAt` legible. */
  noDate: number
}

/** `2026-09-14` → `14 sep`. */
export function dayLabelOf(key: string): string {
  const [, month, day] = key.split("-")
  return `${Number(day)} ${MONTHS_ES_SHORT[Number(month) - 1]}`
}

/** `2026-09-14` → `14 sep 2026`. */
export function dayLongLabelOf(key: string): string {
  return `${dayLabelOf(key)} ${key.slice(0, 4)}`
}

/**
 * Cada día calendario de `from` a `to`, inclusive. Avanza en UTC sobre claves
 * `YYYY-MM-DD`, que ya vienen en hora de México: aquí no hay hora, solo fechas,
 * así que la zona ya no interviene.
 */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  const cursor = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`).getTime()
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end)) return out
  while (cursor.getTime() <= end) {
    out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

function emptyRow(key: string, label: string, longLabel = label): LeadsDayRow {
  return { key, label, longLabel, count: 0, ids: [] }
}

/**
 * Una fila por día de `createdAt` (hora de México) con TODAS las oportunidades
 * creadas ese día.
 *
 * Los días intermedios sin ningún registro se rellenan en cero, para que el eje
 * no comprima un mes sin leads en un solo píxel — misma regla que
 * buildUnassignedByWeek(). Las oportunidades sin `createdAt` legible caen en
 * una fila "Sin fecha" al final en vez de desaparecer.
 */
export function buildLeadsByDay(opps: Opportunity[]): LeadsDayRow[] {
  const byDay = new Map<string, LeadsDayRow>()
  let noDate: LeadsDayRow | null = null

  for (const opp of opps) {
    const key = opp.createdAt ? localDay(opp.createdAt) : ""
    let row: LeadsDayRow
    if (!key) {
      noDate ??= emptyRow(NO_DATE_KEY, NO_DATE_LABEL)
      row = noDate
    } else {
      row = byDay.get(key) ?? emptyRow(key, dayLabelOf(key), dayLongLabelOf(key))
      byDay.set(key, row)
    }
    row.count += 1
    row.ids.push(opp.id)
  }

  const keys = [...byDay.keys()].sort()
  const rows =
    keys.length === 0
      ? []
      : daysBetween(keys[0], keys[keys.length - 1]).map(
          (k) => byDay.get(k) ?? emptyRow(k, dayLabelOf(k), dayLongLabelOf(k))
        )

  if (noDate) rows.push(noDate)
  return rows
}

/**
 * El resumen de la nota al pie. Se acumula sobre las filas ya construidas, no con
 * una segunda pasada sobre `opps`, para que no pueda contar distinto de lo que el
 * gráfico dibuja.
 */
export function summarizeLeadsByDay(rows: LeadsDayRow[]): LeadsDaySummary {
  let total = 0
  let days = 0
  let noDate = 0
  let peak: LeadsDayRow | null = null
  for (const r of rows) {
    total += r.count
    if (r.key === NO_DATE_KEY) {
      noDate += r.count
      continue
    }
    days += 1
    // `>` y no `>=`: ante empate gana el día más antiguo, que es el que primero
    // se ve en el eje.
    if (r.count > 0 && (peak === null || r.count > peak.count)) peak = r
  }
  const dated = total - noDate
  return {
    total,
    days,
    perDay: days === 0 ? 0 : dated / days,
    peak,
    noDate,
  }
}
