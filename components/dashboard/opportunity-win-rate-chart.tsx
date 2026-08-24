"use client"

import { useMemo, useState } from "react"
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts"
import { TrendingUp } from "lucide-react"
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
import { buildStatusByMonth } from "@/lib/opportunity-breakdown"
import { PANEL_SCOPES, scopeOpportunities, type PanelId } from "@/lib/panel-scope"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import {
  BRAND_AMBER,
  CHART_GRID_STROKE,
  CHART_TICK,
  ChartCardContent,
  ChartCardHeader,
  ChartEmpty,
  DashboardCard,
  MissingAwareTick,
  NonZeroTooltipContent,
  ScopePill,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"

const CREADAS_COLOR = BRAND_AMBER
const GANADAS_COLOR = "#10b981"

const chartConfig = {
  creadas: { label: "Oportunidades creadas", color: CREADAS_COLOR },
  pctGanadas: { label: "% ganadas", color: GANADAS_COLOR },
}

const pctFmt = new Intl.NumberFormat("es-MX", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export interface OpportunityWinRateChartProps {
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

export function OpportunityWinRateChart({
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
}: OpportunityWinRateChartProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  const rows = useMemo(
    () => buildStatusByMonth(scopeOpportunities(opportunities, panel, pipelines)),
    [opportunities, panel, pipelines]
  )

  // Se comparte la agregación con "Oportunidades por estado" a propósito: si
  // cada gráfico contara sus propios meses, un día dirían cosas distintas del
  // mismo mes. Aquí solo se derivan las dos series que este dibuja.
  const data = useMemo(
    () =>
      rows.map((r) => ({
        key: r.key,
        label: r.label,
        creadas: r.total,
        pctGanadas: r.total === 0 ? 0 : (r.ganada / r.total) * 100,
      })),
    [rows]
  )

  const totals = useMemo(() => {
    const creadas = rows.reduce((s, r) => s + r.total, 0)
    const ganadas = rows.reduce((s, r) => s + r.ganada, 0)
    return { creadas, ganadas, pct: creadas === 0 ? 0 : (ganadas / creadas) * 100 }
  }, [rows])

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  // El drill entra por la barra y trae la cohorte COMPLETA del mes, no solo las
  // ganadas: el punto del gráfico es qué proporción de ese grupo cerró, y el
  // drawer ya distingue el estatus de cada renglón.
  const openDrill = (monthKey: string) => {
    const row = rows.find((r) => r.key === monthKey)
    if (!row) return
    const items = [...row.ids.ganada, ...row.ids.abierta, ...row.ids.perdida]
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    if (items.length === 0) return
    setDrill({
      open: true,
      title: `${row.label} — Oportunidades creadas`,
      subtitle: `Embudo ${scope.label} · ${row.ganada} ganadas`,
      opportunities: items,
    })
  }

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Oportunidades creadas y % ganadas"
        icon={TrendingUp}
        total={`${pctFmt.format(totals.pct)}%`}
        actions={
          <ScopePill
            label="Cohorte por mes de creación"
            tooltip={
              <>
                Las barras cuentan las oportunidades del embudo{" "}
                <strong>{scope.label}</strong> creadas en cada mes; la línea es qué porcentaje de{" "}
                <em>esa misma cohorte</em> terminó ganada. Ojo con los meses recientes: sus
                oportunidades todavía están abiertas, así que su porcentaje solo puede subir y
                aún no es comparable con el de un mes cerrado.
              </>
            }
          />
        }
      />
      <ChartCardContent>
        {totals.creadas === 0 ? (
          <ChartEmpty message="Sin oportunidades en el periodo seleccionado" />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: CREADAS_COLOR }}
                  aria-hidden
                />
                Oportunidades creadas
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="h-0.5 w-4 shrink-0 rounded-full"
                  style={{ backgroundColor: GANADAS_COLOR }}
                  aria-hidden
                />
                % ganadas
              </span>
              <span className="ml-auto tabular-nums">
                {totals.ganadas.toLocaleString("es-MX")} ganadas de{" "}
                {totals.creadas.toLocaleString("es-MX")}
              </span>
            </div>
            <ChartContainer config={chartConfig} className="h-[280px] w-full">
              <ComposedChart data={data} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID_STROKE} />
                <XAxis
                  dataKey="label"
                  // El tick de "Sin fecha" va en rojizo; ver MissingAwareTick.
                  tick={<MissingAwareTick />}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                  minTickGap={12}
                />
                <YAxis
                  yAxisId="creadas"
                  tick={CHART_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  allowDecimals={false}
                />
                {/* La tasa de cierre ronda el 2–6%: un eje fijo a 100% dejaría
                    la línea pegada al suelo, sin poder leer la tendencia. */}
                <YAxis
                  yAxisId="pct"
                  orientation="right"
                  tick={CHART_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <ChartTooltip
                  content={
                    <NonZeroTooltipContent
                      formatter={(value, name) => (
                        <span>
                          {name === "pctGanadas"
                            ? `% ganadas: ${pctFmt.format(Number(value))}%`
                            : `Creadas: ${Number(value).toLocaleString("es-MX")}`}
                        </span>
                      )}
                    />
                  }
                />
                <Bar
                  yAxisId="creadas"
                  dataKey="creadas"
                  fill={CREADAS_COLOR}
                  radius={[3, 3, 0, 0]}
                  cursor="pointer"
                  onClick={(payload: { key?: string }) => {
                    if (payload?.key) openDrill(payload.key)
                  }}
                />
                <Line
                  yAxisId="pct"
                  type="monotone"
                  dataKey="pctGanadas"
                  stroke={GANADAS_COLOR}
                  strokeWidth={2}
                  dot={{ r: 3, fill: GANADAS_COLOR, strokeWidth: 0 }}
                  activeDot={{ r: 5 }}
                />
              </ComposedChart>
            </ChartContainer>
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
