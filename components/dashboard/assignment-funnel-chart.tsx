"use client"

import { useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { UserX } from "lucide-react"
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
  activeBuckets,
  buildUnassignedByMonth,
  summarizeUnassigned,
  type UnassignedMonthRow,
} from "@/lib/assignment-funnel"
import { STATUS_LABELS, type StatusBucket } from "@/lib/opportunity-breakdown"
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
  MissingAwareTick,
  NonZeroTooltipContent,
  STRUCTURAL_NAVY,
  ScopePill,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"

/**
 * Los mismos colores EXACTOS de "Oportunidades por estado": es la misma pregunta
 * sobre los mismos registros, solo que recortada a los leads que nadie tomó, y
 * dos verdes distintos para "ganada" harían leer los dos charts como sistemas
 * separados.
 *
 * Ya no hay un cuarto tono para "sin asesor": el universo entero de esta tarjeta
 * son las sin asesor, así que un segmento con ese nombre sería la barra completa.
 */
const config: ChartConfig = {
  perdida: { label: STATUS_LABELS.perdida, color: "#ef4444" },
  abierta: { label: STATUS_LABELS.abierta, color: STRUCTURAL_NAVY },
  ganada: { label: STATUS_LABELS.ganada, color: "#10b981" },
}

/** Orden del apilado, de abajo hacia arriba. */
const STACK_ORDER: StatusBucket[] = ["perdida", "abierta", "ganada"]

const n = (v: number) => v.toLocaleString("es-MX")
const pctFmt = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 })

export interface AssignmentFunnelChartProps {
  panel: PanelId
  /** Oportunidades ya filtradas por fecha y por el toggle de HubSpot. */
  opportunities: Opportunity[]
  /** Sin filtrar — los joins del drawer se resuelven contra estas. */
  allOpportunities: Opportunity[]
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

export function AssignmentFunnelChart({
  panel,
  opportunities,
  allOpportunities,
  contacts,
  allContacts,
  pipelines = [],
  tasks = [],
  calls = [],
  allPautas = [],
  appointments = [],
  messages = [],
  locationId = "",
}: AssignmentFunnelChartProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  const rows = useMemo(
    () => buildUnassignedByMonth(scopeOpportunities(opportunities, panel, pipelines)),
    [opportunities, panel, pipelines]
  )

  const summary = useMemo(() => summarizeUnassigned(rows), [rows])

  // Solo las cubetas con registros llegan al apilado y a la leyenda.
  const buckets = useMemo(
    () => STACK_ORDER.filter((b) => activeBuckets(rows).includes(b)),
    [rows]
  )

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  const openDrill = (monthKey: string, bucket: StatusBucket) => {
    const row = rows.find((r) => r.key === monthKey)
    if (!row) return
    const items = row.ids[bucket]
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    if (items.length === 0) return
    setDrill({
      open: true,
      title: `${row.label} — ${STATUS_LABELS[bucket]}`,
      subtitle: `Embudo ${scope.label} · sin asesor asignado`,
      opportunities: items,
    })
  }

  // ChartStyle emite `--color-<clave>` bajo el selector [data-chart=chart-<id>],
  // y la leyenda vive FUERA del ChartContainer. Marcar el bloque de chips con el
  // MISMO data-chart es lo que le trae esas variables.
  const chartId = `asignacion-${panel}`

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Leads sin asesor por mes"
        icon={UserX}
        total={summary.total}
        actions={
          <ScopePill
            label="Por mes de creación"
            tooltip={
              <>
                Cuenta <strong>solo</strong> las oportunidades del embudo{" "}
                <strong>{scope.label}</strong> que <strong>no tienen asesor asignado</strong>,
                agrupadas por el mes en que se crearon y partidas por su estatus. Las que sí
                tienen asesor no aparecen aquí: para eso están &ldquo;Oportunidades por
                estado&rdquo; y la tabla por asesor. El porcentaje del tooltip es cuánto pesan
                los huérfanos dentro de todos los leads de ese mes. Un mes que tuvo leads pero
                ninguno huérfano se dibuja en cero, porque esa barra vacía es una buena
                noticia.
              </>
            }
          />
        }
      />
      <ChartCardContent>
        {summary.total === 0 ? (
          // Dos vacíos distintos, y NINGUNO usa el rojizo de cubeta centinela:
          // que no haya leads es un periodo vacío, y que no haya huérfanos es
          // literalmente la meta de la tarjeta.
          <ChartEmpty
            message={
              summary.grandTotal === 0
                ? "Sin oportunidades en el periodo seleccionado"
                : "Todos los leads del periodo tienen asesor asignado"
            }
          />
        ) : (
          <>
            <div
              data-chart={`chart-${chartId}`}
              className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1"
            >
              {/* Al revés que el apilado: la leyenda se lee de arriba abajo, y
                  el stack se dibuja de abajo arriba. */}
              {[...buckets].reverse().map((bucket) => (
                <span
                  key={bucket}
                  className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: `var(--color-${bucket})` }}
                    aria-hidden
                  />
                  {STATUS_LABELS[bucket]}
                </span>
              ))}
            </div>

            <ChartContainer id={chartId} config={config} className="h-[280px] w-full">
              <BarChart data={rows} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID_STROKE} />
                <XAxis
                  dataKey="label"
                  // Tick propio: la cubeta "Sin fecha" va en rojizo.
                  tick={<MissingAwareTick />}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                  minTickGap={12}
                />
                <YAxis
                  tick={CHART_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  allowDecimals={false}
                />
                <ChartTooltip
                  content={
                    <NonZeroTooltipContent
                      labelFormatter={(value, payload) => {
                        const row = payload?.[0]?.payload as UnassignedMonthRow | undefined
                        if (!row || row.monthTotal === 0) return value
                        return (
                          <>
                            <div>{value}</div>
                            <div className="font-normal text-muted-foreground">
                              {pctFmt.format(row.pctSinAsesor)}% de los {n(row.monthTotal)} leads
                              del mes
                            </div>
                          </>
                        )
                      }}
                    />
                  }
                />
                {buckets.map((bucket, i) => (
                  <Bar
                    key={bucket}
                    dataKey={bucket}
                    stackId="asignacion"
                    fill={`var(--color-${bucket})`}
                    // Solo la serie de hasta arriba lleva esquinas redondeadas, o
                    // el apilado se ve partido en bloques sueltos.
                    radius={i === buckets.length - 1 ? [3, 3, 0, 0] : undefined}
                    cursor="pointer"
                    onClick={(payload: { key?: string }) => {
                      if (payload?.key) openDrill(payload.key, bucket)
                    }}
                  />
                ))}
              </BarChart>
            </ChartContainer>

            <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
              <span className={cn("font-medium", MISSING_TEXT)}>{n(summary.total)}</span> de{" "}
              {n(summary.grandTotal)} leads ({pctFmt.format(summary.pctSinAsesor)}%) nunca se
              asignaron a un asesor. La gráfica muestra solo a esos:{" "}
              {n(summary.byBucket.perdida)}{" "}
              {summary.byBucket.perdida === 1 ? "ya se dio por perdido" : "ya se dieron por perdidos"} y{" "}
              {n(summary.byBucket.abierta)}{" "}
              {summary.byBucket.abierta === 1 ? "sigue abierto" : "siguen abiertos"}
              {summary.byBucket.ganada === 0
                ? ", y no se ha ganado ninguno"
                : summary.byBucket.ganada === 1
                  ? ", y 1 se ganó"
                  : `, y ${n(summary.byBucket.ganada)} se ganaron`}
              . Asignar el lead se corrige en GHL, no aquí.
            </p>
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
