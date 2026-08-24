"use client"

import { useMemo, useState } from "react"
import { ListChecks } from "lucide-react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import type {
  Appointment,
  Call,
  Contact,
  Message,
  Opportunity,
  Pauta,
  Pipeline,
  Task,
} from "@/lib/types"
import {
  buildTaskBacklog,
  MISSING_TASK_BUCKETS,
  TASK_BUCKETS,
  TASK_BUCKET_LABELS,
  type TaskBacklogCell,
  type TaskBucket,
} from "@/lib/task-backlog"
import { PANEL_SCOPES, scopeOpportunities, type PanelId } from "@/lib/panel-scope"
import { cn } from "@/lib/utils"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import {
  CHART_GRID_STROKE,
  CHART_TICK,
  ChartCardContent,
  ChartCardHeader,
  ChartEmpty,
  DashboardCard,
  MISSING_TEXT,
  NonZeroTooltipContent,
  ScopePill,
  SERIES_NEUTRALS,
  SERIES_PALETTE,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"

const n = (v: number) => v.toLocaleString("es-MX")

/**
 * Color por cubeta. Las cuatro con fecha toman SERIES_PALETTE —validada por
 * pares para stacks— y "Sin fecha" toma el gris de SERIES_NEUTRALS: es un hueco
 * de captura, no un plazo, y el gris lo dice sin inventar una quinta urgencia.
 * La asignación es posicional; la leyenda es la que carga el significado.
 */
const BUCKET_COLOR: Record<TaskBucket, { light: string; dark: string }> = {
  vencidas: { light: SERIES_PALETTE.light[0], dark: SERIES_PALETTE.dark[0] },
  hoy: { light: SERIES_PALETTE.light[1], dark: SERIES_PALETTE.dark[1] },
  prox7: { light: SERIES_PALETTE.light[2], dark: SERIES_PALETTE.dark[2] },
  adelante: { light: SERIES_PALETTE.light[3], dark: SERIES_PALETTE.dark[3] },
  sinFecha: SERIES_NEUTRALS.empty,
}

export interface TaskBacklogChartProps {
  panel: PanelId
  /** Oportunidades ya filtradas por fecha — NO se usan aquí; ver allOpportunities. */
  opportunities: Opportunity[]
  /** Sin filtrar POR FECHA, pero ya con los filtros de panel puestos. */
  allOpportunities: Opportunity[]
  /**
   * El set crudo, sin filtro de panel ni toggle de HubSpot. Solo se usa para
   * decidir quién es huérfano: `allOpportunities` no sirve para eso porque, con
   * un filtro de sucursal puesto, un contacto cuya oportunidad quedó fuera se
   * vería idéntico a uno que nunca tuvo ninguna — y la nota al pie afirmaría
   * algo falso sobre el dato.
   */
  unfilteredOpportunities: Opportunity[]
  /** Tareas SIN filtrar por fecha: "vencida" es una condición de hoy. */
  allTasks: Task[]
  contacts: Contact[]
  allContacts: Contact[]
  pipelines?: Pipeline[]
  tasks?: Task[]
  calls?: Call[]
  allPautas?: Pauta[]
  appointments?: Appointment[]
  messages?: Message[]
  locationId?: string
}

/**
 * "Tareas pendientes por asesor": cuánto rezago carga cada quien y qué tan
 * vencido está.
 *
 * Es la contraparte de AdvisorStageTable: esa dice qué cartera tiene cada
 * asesor, esta dice qué de esa cartera ya se le pasó.
 *
 * Las tareas de GHL no traen opportunityId, así que el reparto por línea de
 * negocio va contacto → sus oportunidades → embudo. Un contacto con
 * oportunidades en las dos líneas pone su tarea en los dos paneles; la tarea que
 * no se puede atribuir va a la nota de abajo, fuera del agregado — sea porque su
 * contacto no tiene ninguna oportunidad, o porque la tarea no trae contacto.
 */
export function TaskBacklogChart({
  panel,
  allOpportunities,
  unfilteredOpportunities,
  allTasks,
  contacts,
  allContacts,
  pipelines = [],
  tasks = [],
  calls = [],
  allPautas = [],
  appointments = [],
  messages = [],
  locationId = "",
}: TaskBacklogChartProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  const backlog = useMemo(() => {
    const scoped = scopeOpportunities(allOpportunities, panel, pipelines)
    return buildTaskBacklog(allTasks, scoped, unfilteredOpportunities, new Date())
  }, [allTasks, allOpportunities, unfilteredOpportunities, panel, pipelines])

  const config: ChartConfig = useMemo(() => {
    const out: ChartConfig = {}
    for (const b of TASK_BUCKETS) {
      out[b] = { label: TASK_BUCKET_LABELS[b], theme: BUCKET_COLOR[b] }
    }
    return out
  }, [])

  // Recharts consume filas planas. Las cubetas en cero se dejan AUSENTES, no en
  // cero: un cero mete un rectángulo de altura 0 en el stack.
  const rows = useMemo(
    () =>
      backlog.rows.map((r) => {
        const row: Record<string, string | number> = { advisor: r.advisor, total: r.total }
        for (const b of TASK_BUCKETS) {
          const c = r.buckets[b].count
          if (c) row[b] = c
        }
        return row
      }),
    [backlog.rows]
  )

  const contactById = useMemo(
    () => new Map((allContacts.length > 0 ? allContacts : contacts).map((c) => [c.id, c])),
    [allContacts, contacts]
  )

  const taskById = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks])

  /**
   * Drill de TAREAS. Es el que usa la nota al pie, y no puede ser el de
   * contactos: sus tareas son justamente las que no tienen a quién resolver —
   * una tarea de GHL puede venir sin `contactId`, y `openDrill` las descartaba
   * en silencio, dejando la nota clickeable pero muerta.
   */
  const openTaskDrill = (cell: TaskBacklogCell, title: string, note: string) => {
    if (cell.count === 0) return
    const taskItems = cell.taskIds
      .map((id) => taskById.get(id))
      .filter((t): t is Task => Boolean(t))
    if (taskItems.length === 0) return
    setDrill({
      open: true,
      title,
      subtitle: note,
      opportunities: [],
      taskItems,
    })
  }

  const openDrill = (cell: TaskBacklogCell, title: string, note: string) => {
    if (cell.count === 0) return
    const contactItems = cell.contactIds
      .map((id) => contactById.get(id))
      .filter((c): c is Contact => Boolean(c))
    if (contactItems.length === 0) return
    setDrill({
      open: true,
      title,
      subtitle: `Embudo ${scope.label} · ${note}`,
      opportunities: [],
      contactItems,
    })
  }

  const chartId = `tareas-${panel}`
  // El alto sigue al número de asesores: con tres filas el gráfico no debe
  // ocupar 280px de alto vacío, y con quince no debe aplastar las barras.
  const chartHeight = Math.max(140, backlog.rows.length * 34 + 40)

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Tareas pendientes por asesor"
        icon={ListChecks}
        total={backlog.grandTotal}
        actions={
          <ScopePill
            label="Pendientes · a la fecha de hoy"
            tooltip={
              <>
                Tareas <strong>pendientes</strong> de los contactos que tienen al menos una
                oportunidad en el embudo <strong>{scope.label}</strong>, agrupadas por el
                asesor asignado y por qué tan cerca está su vencimiento.{" "}
                <strong>No respeta el filtro de fechas</strong>: &ldquo;vencida&rdquo; es una
                condición de hoy, no de un periodo. Sí respeta los filtros de sucursal,
                asesor, origen y canal. Las tareas de GHL no guardan a qué oportunidad
                pertenecen, así que el reparto por línea de negocio va por el contacto — uno
                con oportunidades en las dos líneas aparece en los dos paneles.
              </>
            }
          />
        }
      />
      <ChartCardContent>
        {backlog.grandTotal === 0 ? (
          <ChartEmpty message="Sin tareas pendientes en este embudo" />
        ) : (
          <>
            <div
              data-chart={`chart-${chartId}`}
              className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1"
            >
              {TASK_BUCKETS.map((b) => {
                const count = backlog.totals.buckets[b].count
                if (count === 0) return null
                return (
                  <span
                    key={b}
                    className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: `var(--color-${b})` }}
                      aria-hidden
                    />
                    {/* La cubeta centinela lleva la ETIQUETA en rojizo, pero su
                        muestra de color sigue en gris: ese cuadro tiene que
                        casar con el segmento del stack. */}
                    <span className={cn(MISSING_TASK_BUCKETS.has(b) && MISSING_TEXT)}>
                      {TASK_BUCKET_LABELS[b]}
                    </span>
                    <span className="tabular-nums">{n(count)}</span>
                  </span>
                )
              })}
            </div>

            {/* Alto por estilo en línea, no por clase: es dinámico. El
                `aspect-video` que trae ChartContainer por defecto queda
                neutralizado — CSS ignora aspect-ratio cuando alto y ancho están
                los dos declarados. */}
            <ChartContainer
              id={chartId}
              config={config}
              style={{ height: chartHeight }}
              className="w-full"
            >
              <BarChart
                data={rows}
                layout="vertical"
                margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={CHART_GRID_STROKE} />
                <XAxis
                  type="number"
                  tick={CHART_TICK}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="advisor"
                  tick={CHART_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={128}
                />
                <ChartTooltip
                  content={
                    <NonZeroTooltipContent
                      formatter={(value, name) => (
                        <div className="flex w-full items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: `var(--color-${name})` }}
                            aria-hidden
                          />
                          <span className="flex-1 truncate text-muted-foreground">
                            {TASK_BUCKET_LABELS[name as TaskBucket] ?? name}
                          </span>
                          <span className="font-mono font-medium tabular-nums text-foreground">
                            {n(Number(value))}
                          </span>
                        </div>
                      )}
                    />
                  }
                />
                {TASK_BUCKETS.map((b) => (
                  <Bar
                    key={b}
                    dataKey={b}
                    stackId="tareas"
                    fill={`var(--color-${b})`}
                    onClick={(_: unknown, index: number) => {
                      const row = backlog.rows[index]
                      if (!row) return
                      openDrill(
                        row.buckets[b],
                        `${row.advisor} — ${TASK_BUCKET_LABELS[b]}`,
                        `${n(row.buckets[b].count)} tareas pendientes`
                      )
                    }}
                    className="cursor-pointer"
                  />
                ))}
              </BarChart>
            </ChartContainer>

            {backlog.unscoped.count > 0 && (
              <button
                type="button"
                onClick={() =>
                  openTaskDrill(
                    backlog.unscoped,
                    "Tareas sin línea de negocio",
                    `${n(backlog.unscoped.count)} ${
                      backlog.unscoped.count === 1 ? "tarea pendiente" : "tareas pendientes"
                    }`
                  )
                }
                className={cn(
                  "mt-2 cursor-pointer text-left text-[11px] underline-offset-2 hover:underline",
                  MISSING_TEXT
                )}
              >
                {n(backlog.unscoped.count)}{" "}
                {backlog.unscoped.count === 1 ? "tarea pendiente" : "tareas pendientes"} sin
                oportunidad que {backlog.unscoped.count === 1 ? "la" : "las"} ubique en una
                línea de negocio —{" "}
                {backlog.unscoped.count === 1 ? "queda" : "quedan"} fuera del gráfico.
              </button>
            )}
          </>
        )}
      </ChartCardContent>

      <ChartDrillDrawer
        drill={drill}
        onDrillChange={setDrill}
        contacts={allContacts.length > 0 ? allContacts : contacts}
        tasks={tasks}
        calls={calls}
        allOpportunities={allOpportunities}
        allPautas={allPautas}
        appointments={appointments}
        messages={messages}
        locationId={locationId}
      />
    </DashboardCard>
  )
}
