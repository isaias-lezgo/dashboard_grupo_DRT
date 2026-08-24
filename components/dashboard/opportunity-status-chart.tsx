"use client"

import { useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { BarChart3 } from "lucide-react"
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
  buildStatusByMonth,
  STATUS_BUCKETS,
  STATUS_LABELS,
  type StatusBucket,
} from "@/lib/opportunity-breakdown"
import { PANEL_SCOPES, scopeOpportunities, type PanelId } from "@/lib/panel-scope"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import {
  CHART_GRID_STROKE,
  CHART_TICK,
  ChartCardContent,
  ChartCardHeader,
  ChartEmpty,
  DashboardCard,
  MissingAwareTick,
  NonZeroTooltipContent,
  STRUCTURAL_NAVY,
  ScopePill,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"

// Colores semánticos, no de marca: en un apilado de ganada/abierta/perdida el
// verde y el rojo ya significan algo antes de leer la leyenda.
const BUCKET_COLORS: Record<StatusBucket, string> = {
  ganada: "#10b981",
  abierta: STRUCTURAL_NAVY,
  perdida: "#ef4444",
}

const chartConfig = {
  ganada: { label: STATUS_LABELS.ganada, color: BUCKET_COLORS.ganada },
  abierta: { label: STATUS_LABELS.abierta, color: BUCKET_COLORS.abierta },
  perdida: { label: STATUS_LABELS.perdida, color: BUCKET_COLORS.perdida },
}

export interface OpportunityStatusChartProps {
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

export function OpportunityStatusChart({
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
}: OpportunityStatusChartProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  const rows = useMemo(
    () => buildStatusByMonth(scopeOpportunities(opportunities, panel, pipelines)),
    [opportunities, panel, pipelines]
  )

  const total = useMemo(() => rows.reduce((sum, r) => sum + r.total, 0), [rows])

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
      subtitle: `Embudo ${scope.label}`,
      opportunities: items,
    })
  }

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Oportunidades por estado"
        icon={BarChart3}
        total={total}
        actions={
          <ScopePill
            label="Por mes de creación"
            tooltip={
              <>
                Oportunidades del embudo <strong>{scope.label}</strong> agrupadas por el mes en
                que se crearon en el CRM. <strong>Ganada</strong> incluye las que se registran
                moviéndolas a una etapa &ldquo;Ganado&rdquo; sin cambiar su estatus;{" "}
                <strong>Perdida</strong> junta las perdidas y las abandonadas. Los meses sin
                movimiento se dibujan en cero para no comprimir el eje.
              </>
            }
          />
        }
      />
      <ChartCardContent>
        {total === 0 ? (
          <ChartEmpty message="Sin oportunidades en el periodo seleccionado" />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
              {STATUS_BUCKETS.map((bucket) => (
                <span key={bucket} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: BUCKET_COLORS[bucket] }}
                    aria-hidden
                  />
                  {STATUS_LABELS[bucket]}
                </span>
              ))}
            </div>
            <ChartContainer config={chartConfig} className="h-[280px] w-full">
              <BarChart data={rows} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID_STROKE} />
                <XAxis
                  dataKey="label"
                  // Tick propio: la cubeta "Sin fecha" va en rojizo, el resto en
                  // el gris de siempre.
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
                <ChartTooltip content={<NonZeroTooltipContent />} />
                {STATUS_BUCKETS.map((bucket, i) => (
                  <Bar
                    key={bucket}
                    dataKey={bucket}
                    stackId="estado"
                    fill={BUCKET_COLORS[bucket]}
                    // Solo la serie de hasta arriba lleva esquinas redondeadas,
                    // o el apilado se ve partido en tres bloques sueltos.
                    radius={i === STATUS_BUCKETS.length - 1 ? [3, 3, 0, 0] : undefined}
                    cursor="pointer"
                    onClick={(payload: { key?: string }) => {
                      if (payload?.key) openDrill(payload.key, bucket)
                    }}
                  />
                ))}
              </BarChart>
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
