// Agregación detrás de "Tareas pendientes por asesor": el rezago de las tareas
// abiertas, repartido por asesor y por qué tan vencidas están.
//
// Puro y sin React, igual que lib/advisor-breakdown.ts y por la misma razón: un
// conteo mal cubeteado aquí se ve idéntico a uno bien en pantalla. Vive bajo
// scripts/verify-task-backlog.ts.
//
// La frontera de día se calcula SIEMPRE en una zona horaria explícita. El
// servidor corre en UTC en Vercel; sin la zona, una tarea que vence hoy a las
// 23:00 hora de México tiene un ISO del día UTC siguiente y se leería como
// "Más adelante" en vez de "Hoy".
import type { Opportunity, Task } from "./types"
import { NO_ADVISOR_LABEL } from "./advisor-breakdown"

/** La zona del cliente. Las rutas de IA ya usan este mismo default. */
export const PANEL_TIME_ZONE = "America/Mexico_City"

export const TASK_BUCKETS = ["vencidas", "hoy", "prox7", "adelante", "sinFecha"] as const
export type TaskBucket = (typeof TASK_BUCKETS)[number]

export const TASK_BUCKET_LABELS: Record<TaskBucket, string> = {
  vencidas: "Vencidas",
  hoy: "Hoy",
  prox7: "Próx. 7 días",
  adelante: "Más adelante",
  sinFecha: "Sin fecha",
}

/** Cubetas que son un hueco de captura y no una condición del negocio. */
export const MISSING_TASK_BUCKETS: ReadonlySet<TaskBucket> = new Set<TaskBucket>(["sinFecha"])

export interface TaskBacklogCell {
  count: number
  taskIds: string[]
  /** Contactos únicos de la celda, en orden de aparición — para el drill-down. */
  contactIds: string[]
}

export interface TaskBacklogRow {
  advisor: string
  /** true solo en la fila NO_ADVISOR_LABEL, que se pinta distinto y va al final. */
  unassigned: boolean
  total: number
  buckets: Record<TaskBucket, TaskBacklogCell>
  taskIds: string[]
  contactIds: string[]
}

export interface TaskBacklog {
  rows: TaskBacklogRow[]
  /** Fila de totales por cubeta; `advisor` vale "Total". */
  totals: TaskBacklogRow
  /**
   * Tareas que ninguna oportunidad puede atribuir a una línea de negocio. Dos
   * casos caen aquí y NO son lo mismo: el contacto existe pero no tiene ninguna
   * oportunidad (la fuga que vigila "Contactos sin oportunidad"), o la tarea
   * viene SIN `contactId` — GHL lo permite, y entonces `contactIds` queda vacío
   * aunque `count` sea mayor que cero. Quien consuma esta celda debe drillar por
   * `taskIds`, no por `contactIds`, o perderá el segundo caso en silencio.
   *
   * No se tiran: quedan fuera del agregado porque no hay dato que las atribuya.
   */
  unscoped: TaskBacklogCell
  grandTotal: number
}

function emptyCell(): TaskBacklogCell {
  return { count: 0, taskIds: [], contactIds: [] }
}

function emptyRow(advisor: string, unassigned = false): TaskBacklogRow {
  const buckets = {} as Record<TaskBucket, TaskBacklogCell>
  for (const b of TASK_BUCKETS) buckets[b] = emptyCell()
  return { advisor, unassigned, total: 0, buckets, taskIds: [], contactIds: [] }
}

function push(cell: TaskBacklogCell, taskId: string, contactId: string) {
  cell.count += 1
  cell.taskIds.push(taskId)
  if (contactId && !cell.contactIds.includes(contactId)) cell.contactIds.push(contactId)
}

/**
 * Índice de día calendario en `timeZone`: días enteros desde la época. Restar
 * dos de estos da la diferencia en DÍAS LOCALES, que es la única resta que no
 * se equivoca cerca de la medianoche ni en un cambio de horario.
 *
 * `en-CA` se usa porque formatea como YYYY-MM-DD, que se parsea sin ambigüedad.
 */
function dayIndex(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
  const [y, m, day] = parts.split("-").map(Number)
  return Date.UTC(y, m - 1, day) / 86_400_000
}

/**
 * Cubeta de vencimiento de una tarea. Sin `dueDate` o con una fecha ilegible ⇒
 * `sinFecha`: no es "más adelante", es un dato que nadie capturó.
 */
export function bucketOfDueDate(
  dueDate: string | undefined,
  now: Date,
  timeZone: string = PANEL_TIME_ZONE
): TaskBucket {
  if (!dueDate) return "sinFecha"
  const due = new Date(dueDate)
  if (Number.isNaN(due.getTime())) return "sinFecha"

  const diff = dayIndex(due, timeZone) - dayIndex(now, timeZone)
  if (diff < 0) return "vencidas"
  if (diff === 0) return "hoy"
  if (diff <= 7) return "prox7"
  return "adelante"
}

/**
 * Rezago de tareas del panel.
 *
 * `scopedOpportunities` ya viene acotado al embudo del panel y a los filtros
 * globales; `allOpportunities` es el set completo y sirve solo para distinguir
 * al contacto huérfano (sin ninguna oportunidad, va a `unscoped`) del contacto
 * que sí tiene oportunidades pero en la otra línea (simplemente no cuenta aquí).
 *
 * Ignora el filtro global de fechas a propósito: "vencida" es una condición de
 * hoy, no de un periodo.
 */
export function buildTaskBacklog(
  tasks: Task[],
  scopedOpportunities: Opportunity[],
  allOpportunities: Opportunity[],
  now: Date,
  timeZone: string = PANEL_TIME_ZONE
): TaskBacklog {
  const scopedContacts = new Set<string>()
  for (const o of scopedOpportunities) if (o.contactId) scopedContacts.add(o.contactId)

  const anyContacts = new Set<string>()
  for (const o of allOpportunities) if (o.contactId) anyContacts.add(o.contactId)

  const byAdvisor = new Map<string, TaskBacklogRow>()
  const unscoped = emptyCell()

  for (const t of tasks) {
    if (t.status !== "pending") continue

    if (!scopedContacts.has(t.contactId)) {
      // Sin ninguna oportunidad ⇒ no es atribuible a una línea, se reporta
      // aparte. Con oportunidades solo en la otra línea ⇒ se descarta aquí.
      if (!anyContacts.has(t.contactId)) push(unscoped, t.id, t.contactId)
      continue
    }

    const name = (t.assignedToName ?? "").trim() || NO_ADVISOR_LABEL
    let row = byAdvisor.get(name)
    if (!row) {
      row = emptyRow(name, name === NO_ADVISOR_LABEL)
      byAdvisor.set(name, row)
    }

    push(row.buckets[bucketOfDueDate(t.dueDate, now, timeZone)], t.id, t.contactId)
    row.total += 1
    row.taskIds.push(t.id)
    if (t.contactId && !row.contactIds.includes(t.contactId)) row.contactIds.push(t.contactId)
  }

  const rows = [...byAdvisor.values()].sort((a, b) => {
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1
    return b.total - a.total || a.advisor.localeCompare(b.advisor, "es")
  })

  // Los totales se acumulan sobre las filas YA calculadas, para que no exista
  // una segunda pasada sobre `tasks` que pueda contar distinto.
  const totals = emptyRow("Total")
  for (const r of rows) {
    totals.total += r.total
    totals.taskIds.push(...r.taskIds)
    for (const c of r.contactIds) if (!totals.contactIds.includes(c)) totals.contactIds.push(c)
    for (const b of TASK_BUCKETS) {
      const src = r.buckets[b]
      const dst = totals.buckets[b]
      dst.count += src.count
      dst.taskIds.push(...src.taskIds)
      for (const c of src.contactIds) if (!dst.contactIds.includes(c)) dst.contactIds.push(c)
    }
  }

  return { rows, totals, unscoped, grandTotal: totals.total }
}
