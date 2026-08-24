// Agregación detrás de "Oportunidades por asesor": la matriz asesor × etapa del
// embudo, más el desglose de estatus (ganada / abierta / perdida) de cada asesor.
//
// Puro y sin React, igual que lib/opportunity-breakdown.ts y por la misma razón:
// un conteo silenciosamente mal aquí se ve idéntico a uno bien en la UI, así que
// vive bajo scripts/verify-advisors.ts.
import type { Opportunity, Pipeline } from "./types"
import { statusBucket, STATUS_BUCKETS, type StatusBucket } from "./opportunity-breakdown"
import { resolvePipelineId, type PanelId } from "./panel-scope"

/**
 * Fila de las oportunidades que nadie tiene asignadas. NO se descarta: en el
 * embudo VAEO son más de mil registros, casi todos ya perdidos, y esconderlos
 * haría que la matriz sumara mucho menos que el total del panel sin explicar por
 * qué. Se muestra siempre al final y en gris — no es un asesor, es una fuga.
 */
export const NO_ADVISOR_LABEL = "Sin asesor"

/** Etapas que la oportunidad tiene pero el embudo ya no declara. */
export const OTHER_STAGE_LABEL = "Otra etapa"

export type StageKind = "ganado" | "perdido" | "abierto"

/**
 * Qué significa una etapa por su NOMBRE, nunca por su id — misma regla que
 * isWonOpp(): un embudo recreado conserva el nombre pero no el id.
 */
export function stageKind(stage: string): StageKind {
  if (/ganad[oa]|\bwon\b/i.test(stage)) return "ganado"
  if (/perdid[oa]|\blost\b/i.test(stage)) return "perdido"
  return "abierto"
}

export interface AdvisorCell {
  count: number
  /** Ids de las oportunidades de la celda, para el drill-down. */
  oppIds: string[]
}

export interface AdvisorRow {
  advisor: string
  /** true solo en la fila NO_ADVISOR_LABEL, que se pinta distinto y va al final. */
  unassigned: boolean
  total: number
  oppIds: string[]
  /** Una celda por etapa, con la MISMA clave que `AdvisorMatrix.stages`. */
  stages: Record<string, AdvisorCell>
  status: Record<StatusBucket, AdvisorCell>
  /** Ganadas sobre el total de la fila, 0–100. */
  winRate: number
}

export interface AdvisorMatrix {
  /** Nombres de etapa en orden de embudo — el orden de las columnas. */
  stages: string[]
  rows: AdvisorRow[]
  /** Fila de totales por columna; `advisor` vale "Total". */
  totals: AdvisorRow
  /** Máximo de cada columna. La intensidad del mapa de calor se normaliza aquí. */
  stageMax: Record<string, number>
}

/** Clave de comparación de etapas: insensible a mayúsculas y a espacios sobrantes. */
function stageKey(stage: string): string {
  return stage.trim().toLowerCase()
}

function emptyRow(advisor: string, stages: string[], unassigned = false): AdvisorRow {
  const row: AdvisorRow = {
    advisor,
    unassigned,
    total: 0,
    oppIds: [],
    stages: {},
    status: {
      ganada: { count: 0, oppIds: [] },
      abierta: { count: 0, oppIds: [] },
      perdida: { count: 0, oppIds: [] },
    },
    winRate: 0,
  }
  for (const s of stages) row.stages[s] = { count: 0, oppIds: [] }
  return row
}

/**
 * El orden de columnas: las etapas declaradas por el embudo del panel, en el
 * orden en que GHL las lista (que es el orden del embudo, no alfabético).
 *
 * Se prefiere la definición del embudo sobre lo que traigan las oportunidades
 * porque así una etapa sin ningún registro sigue apareciendo como columna vacía:
 * "nadie tiene nada en Negociación" es justamente el dato que se quiere ver.
 */
export function panelStageOrder(
  pipelines: Pipeline[] | undefined,
  panel: PanelId
): string[] {
  const id = resolvePipelineId(pipelines, panel)
  return pipelines?.find((p) => p.id === id)?.stages ?? []
}

/**
 * Matriz asesor × etapa sobre `opps` (que ya deben venir acotadas al embudo del
 * panel — este módulo no filtra por pipeline).
 *
 * Reglas:
 * - El asesor es `opp.assignedTo`, que la ruta de sync ya resolvió de id a nombre.
 *   Vacío ⇒ fila "Sin asesor".
 * - Una etapa que traiga una oportunidad pero que el embudo ya no declare se
 *   agrega como columna extra al final, en vez de perder el registro.
 * - Las filas se ordenan por volumen descendente; "Sin asesor" siempre al final.
 */
export function buildAdvisorMatrix(
  opps: Opportunity[],
  stageOrder: string[]
): AdvisorMatrix {
  // Etapas del embudo, más las que aparezcan en los datos y no estén declaradas.
  const stages = [...stageOrder]
  const stageByKey = new Map(stageOrder.map((s) => [stageKey(s), s]))
  for (const o of opps) {
    const raw = (o.stage ?? "").trim()
    const key = stageKey(raw || OTHER_STAGE_LABEL)
    if (stageByKey.has(key)) continue
    const label = raw || OTHER_STAGE_LABEL
    stageByKey.set(key, label)
    stages.push(label)
  }

  const byAdvisor = new Map<string, AdvisorRow>()

  for (const o of opps) {
    const name = (o.assignedTo ?? "").trim() || NO_ADVISOR_LABEL
    let row = byAdvisor.get(name)
    if (!row) {
      row = emptyRow(name, stages, name === NO_ADVISOR_LABEL)
      byAdvisor.set(name, row)
    }

    const stage = stageByKey.get(stageKey((o.stage ?? "").trim() || OTHER_STAGE_LABEL))!
    const cell = row.stages[stage]
    cell.count += 1
    cell.oppIds.push(o.id)

    const bucket = statusBucket(o)
    row.status[bucket].count += 1
    row.status[bucket].oppIds.push(o.id)

    row.total += 1
    row.oppIds.push(o.id)
  }

  const rows = [...byAdvisor.values()].sort((a, b) => {
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1
    return b.total - a.total || a.advisor.localeCompare(b.advisor, "es")
  })

  for (const r of rows) {
    r.winRate = r.total === 0 ? 0 : (r.status.ganada.count / r.total) * 100
  }

  // Totales por columna. Se construye acumulando las filas ya calculadas para
  // que no exista una segunda pasada sobre `opps` que pueda contar distinto.
  const totals = emptyRow("Total", stages)
  for (const r of rows) {
    totals.total += r.total
    totals.oppIds.push(...r.oppIds)
    for (const s of stages) {
      const src = r.stages[s]
      if (!src) continue
      totals.stages[s].count += src.count
      totals.stages[s].oppIds.push(...src.oppIds)
    }
    for (const b of STATUS_BUCKETS) {
      totals.status[b].count += r.status[b].count
      totals.status[b].oppIds.push(...r.status[b].oppIds)
    }
  }
  totals.winRate = totals.total === 0 ? 0 : (totals.status.ganada.count / totals.total) * 100

  // El máximo excluye la fila de totales (siempre sería ella) y también la de
  // "Sin asesor": con 1 400 perdidas sin asignar, normalizar contra esa columna
  // dejaría a los tres asesores en un gris indistinguible.
  const stageMax: Record<string, number> = {}
  for (const s of stages) {
    let max = 0
    for (const r of rows) {
      if (r.unassigned) continue
      max = Math.max(max, r.stages[s]?.count ?? 0)
    }
    stageMax[s] = max
  }

  return { stages, rows, totals, stageMax }
}
