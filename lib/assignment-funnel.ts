// Agregación detrás de "Leads sin asesor por mes".
//
// El universo de esta tarjeta son EXCLUSIVAMENTE las oportunidades que nadie
// tiene asignadas. Las que sí tienen asesor no aparecen ni como segmento ni como
// barra: para eso están "Oportunidades por estado" y la tabla por asesor. Aquí la
// pregunta es qué pasa con lo que no le llegó a nadie.
//
// Puro y sin React, igual que lib/opportunity-breakdown.ts y por la misma razón:
// un conteo silenciosamente mal aquí se ve idéntico a uno bien en la UI. Vive
// bajo scripts/verify-assignment-funnel.ts.
import type { Opportunity } from "./types"
import {
  statusBucket,
  STATUS_BUCKETS,
  monthKeyOf,
  monthLabelOf,
  monthsBetween,
  NO_DATE_KEY,
  NO_DATE_LABEL,
  type StatusBucket,
} from "./opportunity-breakdown"

/** Sin asesor asignado. El `assignedTo` ya viene resuelto de id a nombre. */
export function isUnassigned(opp: Opportunity): boolean {
  return !(opp.assignedTo ?? "").trim()
}

export interface UnassignedMonthRow {
  /** `YYYY-MM`, o NO_DATE_KEY para la fila sin fecha. */
  key: string
  label: string
  ganada: number
  abierta: number
  perdida: number
  /** Sin asesor en el mes — la altura de la barra. */
  total: number
  /**
   * TODOS los leads creados ese mes, con y sin asesor. No se dibuja: es el
   * denominador del porcentaje.
   *
   * Se conserva porque al recortar el universo a las sin asesor la barra pierde
   * la escala que le daba sentido — 624 leads huérfanos en julio suena distinto
   * si el mes trajo 700 que si trajo 1 438. El dato sigue en el tooltip y en la
   * nota al pie aunque ya no esté en el eje.
   */
  monthTotal: number
  /** Sin asesor sobre el total del mes, 0–100. */
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

function emptyRow(key: string, label: string): UnassignedMonthRow {
  return {
    key,
    label,
    ganada: 0,
    abierta: 0,
    perdida: 0,
    total: 0,
    monthTotal: 0,
    pctSinAsesor: 0,
    ids: { ganada: [], abierta: [], perdida: [] },
  }
}

/**
 * Una fila por mes de `createdAt` con las oportunidades SIN ASESOR de ese mes,
 * partidas por estatus.
 *
 * Recibe el set completo del panel, no solo las huérfanas: necesita las
 * asignadas para poder calcular `monthTotal`, que es lo que convierte "624" en
 * "el 43% del mes".
 *
 * Los meses intermedios sin ningún registro se rellenan en cero, para que el eje
 * no insinúe continuidad donde no la hay — misma regla, y mismos helpers, que
 * buildStatusByMonth(). Un mes que SÍ tuvo leads pero ninguno huérfano también
 * se dibuja: una barra en cero ahí es una buena noticia, no un hueco.
 *
 * Las oportunidades sin `createdAt` legible caen en una fila "Sin fecha" al
 * final en vez de desaparecer.
 */
export function buildUnassignedByMonth(opps: Opportunity[]): UnassignedMonthRow[] {
  const byMonth = new Map<string, UnassignedMonthRow>()
  let noDate: UnassignedMonthRow | null = null

  const rowFor = (opp: Opportunity): UnassignedMonthRow => {
    const key = monthKeyOf(opp.createdAt)
    if (key === null) {
      noDate ??= emptyRow(NO_DATE_KEY, NO_DATE_LABEL)
      return noDate
    }
    const row = byMonth.get(key) ?? emptyRow(key, monthLabelOf(key))
    byMonth.set(key, row)
    return row
  }

  for (const opp of opps) {
    const row = rowFor(opp)
    // El denominador cuenta a TODOS; solo las huérfanas siguen al apilado.
    row.monthTotal += 1
    if (!isUnassigned(opp)) continue
    const bucket = statusBucket(opp)
    row[bucket] += 1
    row.total += 1
    row.ids[bucket].push(opp.id)
  }

  const keys = [...byMonth.keys()].sort()
  const rows =
    keys.length === 0
      ? []
      : monthsBetween(keys[0], keys[keys.length - 1]).map(
          (k) => byMonth.get(k) ?? emptyRow(k, monthLabelOf(k))
        )

  if (noDate) rows.push(noDate)

  for (const r of rows) {
    r.pctSinAsesor = r.monthTotal === 0 ? 0 : (r.total / r.monthTotal) * 100
  }
  return rows
}

/**
 * El resumen de la nota al pie. Se acumula sobre las filas ya construidas, no con
 * una segunda pasada sobre `opps`, para que no pueda contar distinto de lo que el
 * gráfico dibuja.
 */
export function summarizeUnassigned(rows: UnassignedMonthRow[]): UnassignedSummary {
  const byBucket: Record<StatusBucket, number> = { ganada: 0, abierta: 0, perdida: 0 }
  let total = 0
  let grandTotal = 0
  for (const r of rows) {
    total += r.total
    grandTotal += r.monthTotal
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
export function activeBuckets(rows: UnassignedMonthRow[]): StatusBucket[] {
  return STATUS_BUCKETS.filter((b) => rows.some((r) => r[b] > 0))
}
