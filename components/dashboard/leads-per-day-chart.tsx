"use client"

import { useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { CalendarDays } from "lucide-react"
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
import { buildLeadsByDay, summarizeLeadsByDay, type LeadsDayRow } from "@/lib/leads-per-day"
import { NO_DATE_KEY } from "@/lib/opportunity-breakdown"
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
 * Una sola serie, así que no hay leyenda: el título la nombra. Va en el azul
 * estructural de "Abiertas" de la tarjeta vecina, porque aquí el color no
 * codifica nada — es la misma tinta con la que el panel dibuja lo que no es
 * un estatus.
 */
const config: ChartConfig = {
  count: { label: "Leads", color: STRUCTURAL_NAVY },
}

const n = (v: number) => v.toLocaleString("es-MX")
const avgFmt = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 1 })

export interface LeadsPerDayChartProps {
  panel: PanelId
  /** Oportunidades ya filtradas por fecha y por los menús del panel. */
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

export function LeadsPerDayChart({
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
}: LeadsPerDayChartProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  const rows = useMemo(
    () => buildLeadsByDay(scopeOpportunities(opportunities, panel, pipelines)),
    [opportunities, panel, pipelines]
  )

  const summary = useMemo(() => summarizeLeadsByDay(rows), [rows])

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  const openDrill = (dayKey: string) => {
    const row = rows.find((r) => r.key === dayKey)
    if (!row) return
    const items = row.ids
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    if (items.length === 0) return
    setDrill({
      open: true,
      title: row.key === NO_DATE_KEY ? row.label : `Leads del ${row.longLabel}`,
      subtitle: `Embudo ${scope.label} · por día de creación`,
      opportunities: items,
    })
  }

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Leads creados por día"
        icon={CalendarDays}
        total={summary.total}
        actions={
          <ScopePill
            label="Por día de creación"
            tooltip={
              <>
                Cuenta <strong>todas</strong> las oportunidades del embudo{" "}
                <strong>{scope.label}</strong> — con y sin asesor — por el día en que se
                crearon, en hora de México. Es el complemento de &ldquo;Leads sin asesor por
                semana&rdquo;: aquí está cuánto entra cada día; allá, cuánto de eso nadie tomó.
                Los días sin ningún lead se dibujan en cero para que una semana muerta se vea
                como semana muerta y no desaparezca del eje.
              </>
            }
          />
        }
      />
      <ChartCardContent>
        {summary.total === 0 ? (
          <ChartEmpty message="Sin oportunidades en el periodo seleccionado" />
        ) : (
          <>
            <ChartContainer id={`leads-dia-${panel}`} config={config} className="h-[280px] w-full">
              <BarChart data={rows} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID_STROKE} />
                <XAxis
                  dataKey="label"
                  // Tick propio: la cubeta "Sin fecha" va en rojizo.
                  tick={<MissingAwareTick />}
                  tickLine={false}
                  axisLine={false}
                  // Con "Todo" el eje trae cientos de días: solo se rotulan los
                  // que caben, y el primero y el último siempre.
                  interval="preserveStartEnd"
                  minTickGap={24}
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
                        const row = payload?.[0]?.payload as LeadsDayRow | undefined
                        return row?.longLabel ?? value
                      }}
                    />
                  }
                />
                <Bar
                  dataKey="count"
                  fill="var(--color-count)"
                  radius={[3, 3, 0, 0]}
                  cursor="pointer"
                  onClick={(payload: { key?: string }) => {
                    if (payload?.key) openDrill(payload.key)
                  }}
                />
              </BarChart>
            </ChartContainer>

            <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">{n(summary.total)}</span>{" "}
              {summary.total === 1 ? "lead" : "leads"} en {n(summary.days)}{" "}
              {summary.days === 1 ? "día" : "días"} · promedio {avgFmt.format(summary.perDay)} por
              día
              {summary.peak && (
                <>
                  {" "}· pico: <span className="font-medium text-foreground">{n(summary.peak.count)}</span>{" "}
                  el {summary.peak.longLabel}
                </>
              )}
              {summary.noDate > 0 && (
                <>
                  {" "}·{" "}
                  <span className={cn("font-medium", MISSING_TEXT)}>{n(summary.noDate)}</span> sin
                  fecha de creación
                </>
              )}
              .
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
