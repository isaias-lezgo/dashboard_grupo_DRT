// Agregación detrás de "Leads sin asesor por semana".
//
// El universo de esta tarjeta son EXCLUSIVAMENTE las oportunidades que nadie
// tiene asignadas. Las que sí tienen asesor no aparecen ni como segmento ni como
// barra: para eso están "Oportunidades por estado" y la tabla por asesor. Aquí la
// pregunta es qué pasa con lo que no le llegó a nadie.
//
// Puro y sin React, igual que lib/opportunity-breakdown.ts y por la misma razón:
// un conteo silenciosamente mal aquí se ve idéntico a uno bien en la UI. Vive
// bajo scripts/verify-assignment-funnel.ts.
//
// La semana va de LUNES a domingo y se corta sobre el día en America/Mexico_City
// (`localDay`, la misma frontera que "Leads creados por día"): `createdAt` viene
// en UTC, y un lead del domingo a las 22:00 hora de México ya es lunes en UTC —
// sin la zona se iría a la semana siguiente.
import type { Opportunity } from "./types"
import { localDay } from "./meta-attribution"
import { dayLabelOf, dayLongLabelOf, daysBetween } from "./leads-per-day"
import {
  statusBucket,
  STATUS_BUCKETS,
  NO_DATE_KEY,
  NO_DATE_LABEL,
  type StatusBucket,
} from "./opportunity-breakdown"

/**
 * El lunes de la semana a la que pertenece un día `YYYY-MM-DD`. Trabaja en UTC
 * sobre la clave, que ya viene en hora de México: aquí solo hay fechas.
 */
export function weekKeyOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ""
  // getUTCDay: 0 = domingo … 6 = sábado. Retrocede al lunes.
  const back = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - back)
  return d.toISOString().slice(0, 10)
}

/** El domingo que cierra la semana del lunes `key`. */
export function weekEndOf(key: string): string {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().slice(0, 10)
}

/** Etiqueta del eje: el lunes, `15 sep`. */
export function weekLabelOf(key: string): string {
  return dayLabelOf(key)
}

/** Etiqueta del tooltip: `Semana del 15 al 21 sep 2026`. */
export function weekLongLabelOf(key: string): string {
  const end = weekEndOf(key)
  const sameMonth = key.slice(0, 7) === end.slice(0, 7)
  const start = sameMonth ? key.slice(8).replace(/^0/, "") : dayLabelOf(key)
  return `Semana del ${start} al ${dayLongLabelOf(end)}`
}

/** Cada lunes de `from` a `to`, inclusive. Ambos deben ser lunes. */
export function weeksBetween(from: string, to: string): string[] {
  return daysBetween(from, to).filter((_, i) => i % 7 === 0)
}

/** Sin asesor asignado. El `assignedTo` ya viene resuelto de id a nombre. */
export function isUnassigned(opp: Opportunity): boolean {
  return !(opp.assignedTo ?? "").trim()
}

export interface UnassignedWeekRow {
  /** `YYYY-MM-DD` del lunes, o NO_DATE_KEY para la fila sin fecha. */
  key: string
  /** Etiqueta corta del eje: el lunes, `15 sep`. */
  label: string
  /** Etiqueta larga del tooltip: `Semana del 15 al 21 sep 2026`. */
  longLabel: string
  ganada: number
  abierta: number
  perdida: number
  /** Sin asesor en el mes — la altura de la barra. */
  total: number
  /**
   * TODOS los leads creados esa semana, con y sin asesor. No se dibuja: es el
   * denominador del porcentaje.
   *
   * Se conserva porque al recortar el universo a las sin asesor la barra pierde
   * la escala que le daba sentido — 150 leads huérfanos en una semana suena
   * distinto si la semana trajo 170 que si trajo 400. El dato sigue en el
   * tooltip y en la nota al pie aunque ya no esté en el eje.
   */
  weekTotal: number
  /** Sin asesor sobre el total de la semana, 0–100. */
  pctSinAsesor: number
  /** Ids por cubeta, para el drill-down. */
  ids: Record<StatusBucket, string[]>
}

export interface UnassignedSummary {
  /** Sin asesor en todo el periodo. */
  total: number
  /** Todos los leads del periodo, con y sin asesor. */
  grandTotal: number
  pctSinAsesor: number
  /** Por cubeta, sobre las sin asesor. */
  byBucket: Record<StatusBucket, number>
}

function emptyRow(key: string, label: string, longLabel = label): UnassignedWeekRow {
  return {
    key,
    label,
    longLabel,
    ganada: 0,
    abierta: 0,
    perdida: 0,
    total: 0,
    weekTotal: 0,
    pctSinAsesor: 0,
    ids: { ganada: [], abierta: [], perdida: [] },
  }
}

/**
 * Una fila por semana (lunes a domingo) de `createdAt` con las oportunidades
 * SIN ASESOR de esa semana, partidas por estatus.
 *
 * Recibe el set completo del panel, no solo las huérfanas: necesita las
 * asignadas para poder calcular `weekTotal`, que es lo que convierte "150" en
 * "el 43% de la semana".
 *
 * Las semanas intermedias sin ningún registro se rellenan en cero, para que el
 * eje no insinúe continuidad donde no la hay — misma regla que
 * buildStatusByMonth() y buildLeadsByDay(). Una semana que SÍ tuvo leads pero
 * ninguno huérfano también se dibuja: una barra en cero ahí es una buena
 * noticia, no un hueco.
 *
 * Las oportunidades sin `createdAt` legible caen en una fila "Sin fecha" al
 * final en vez de desaparecer.
 */
export function buildUnassignedByWeek(opps: Opportunity[]): UnassignedWeekRow[] {
  const byWeek = new Map<string, UnassignedWeekRow>()
  let noDate: UnassignedWeekRow | null = null

  const rowFor = (opp: Opportunity): UnassignedWeekRow => {
    const key = opp.createdAt ? weekKeyOf(localDay(opp.createdAt)) : ""
    if (!key) {
      noDate ??= emptyRow(NO_DATE_KEY, NO_DATE_LABEL)
      return noDate
    }
    const row = byWeek.get(key) ?? emptyRow(key, weekLabelOf(key), weekLongLabelOf(key))
    byWeek.set(key, row)
    return row
  }

  for (const opp of opps) {
    const row = rowFor(opp)
    // El denominador cuenta a TODOS; solo las huérfanas siguen al apilado.
    row.weekTotal += 1
    if (!isUnassigned(opp)) continue
    const bucket = statusBucket(opp)
    row[bucket] += 1
    row.total += 1
    row.ids[bucket].push(opp.id)
  }

  const keys = [...byWeek.keys()].sort()
  const rows =
    keys.length === 0
      ? []
      : weeksBetween(keys[0], keys[keys.length - 1]).map(
          (k) => byWeek.get(k) ?? emptyRow(k, weekLabelOf(k), weekLongLabelOf(k))
        )

  if (noDate) rows.push(noDate)

  for (const r of rows) {
    r.pctSinAsesor = r.weekTotal === 0 ? 0 : (r.total / r.weekTotal) * 100
  }
  return rows
}

/**
 * El resumen de la nota al pie. Se acumula sobre las filas ya construidas, no con
 * una segunda pasada sobre `opps`, para que no pueda contar distinto de lo que el
 * gráfico dibuja.
 */
export function summarizeUnassigned(rows: UnassignedWeekRow[]): UnassignedSummary {
  const byBucket: Record<StatusBucket, number> = { ganada: 0, abierta: 0, perdida: 0 }
  let total = 0
  let grandTotal = 0
  for (const r of rows) {
    total += r.total
    grandTotal += r.weekTotal
    for (const b of STATUS_BUCKETS) byBucket[b] += r[b]
  }
  return {
    total,
    grandTotal,
    pctSinAsesor: grandTotal === 0 ? 0 : (total / grandTotal) * 100,
    byBucket,
  }
}

/**
 * Las cubetas que de verdad tienen registros, en el orden del apilado.
 *
 * El chart dibuja SOLO estas. Hoy en los dos embudos ninguna oportunidad sin
 * asesor está ganada, así que "Ganadas" no se dibuja ni ocupa un renglón de
 * leyenda; el día que alguien cierre una venta de un lead que nadie tomó, la
 * serie aparece sola. Una serie fija en cero no comunica "esto no pasa", solo
 * mete una entrada de leyenda que nunca corresponde a nada en pantalla — y la
 * afirmación de que no pasa ya la hace la nota al pie, con su número.
 */
export function activeBuckets(rows: UnassignedWeekRow[]): StatusBucket[] {
  return STATUS_BUCKETS.filter((b) => rows.some((r) => r[b] > 0))
}
