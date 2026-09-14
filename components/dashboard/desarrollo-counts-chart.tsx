"use client"

import { useMemo, useState, type ReactNode } from "react"
import { Footprints, Trophy, Users, type LucideIcon } from "lucide-react"
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
  buildDesarrolloCounts,
  type CountKey,
  type DesarrolloCountRow,
} from "@/lib/desarrollo-funnel"
import { PANEL_SCOPES, scopeOpportunities, type PanelId } from "@/lib/panel-scope"
import { cn } from "@/lib/utils"
import {
  BRAND_AMBER,
  ChartCardContent,
  ChartCardHeader,
  ChartEmpty,
  DashboardCard,
  MISSING_TEXT,
  ScopePill,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"

const pctFmt = new Intl.NumberFormat("es-MX", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

export interface DesarrolloCountsChartProps {
  panel: PanelId
  title: string
  icon?: LucideIcon
  /** Cuál de las tres columnas de la agregación dibuja esta tarjeta. */
  measure: CountKey
  scopeLabel: string
  scopeTooltip: ReactNode
  /** Oportunidades ya filtradas por la barra y por fecha. */
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

/**
 * Una barra por desarrollo con uno de los tres recuentos. Las tres tarjetas de
 * la cabecera de GENERAL son este mismo componente sobre la MISMA agregación
 * (`buildDesarrolloCounts`), así que nunca ordenan distinto al mismo
 * desarrollo ni discrepan en quién está en cada fila.
 *
 * Las filas van en el orden de registros aunque la tarjeta dibuje visitas o
 * ventas: así las tres tarjetas se leen en paralelo, fila con fila.
 */
export function DesarrolloCountsChart({
  panel,
  title,
  icon,
  measure,
  scopeLabel,
  scopeTooltip,
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
}: DesarrolloCountsChartProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  const scoped = useMemo(
    () => scopeOpportunities(opportunities, panel, pipelines),
    [opportunities, panel, pipelines]
  )
  const rows = useMemo(() => buildDesarrolloCounts(scoped, pipelines), [scoped, pipelines])

  const total = useMemo(() => rows.reduce((s, r) => s + r[measure], 0), [rows, measure])
  // Escala contra el desarrollo más grande, no contra el total: Cañadas
  // concentra casi la mitad y el resto quedaría en astillas.
  const max = useMemo(() => Math.max(1, ...rows.map((r) => r[measure])), [rows, measure])

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  const openDrill = (row: DesarrolloCountRow) => {
    const items = row.ids[measure]
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    if (items.length === 0) return
    setDrill({
      open: true,
      title: `${title} — ${row.desarrollo}`,
      subtitle: `Embudo ${scope.label}`,
      opportunities: items,
    })
  }

  return (
    <DashboardCard>
      <ChartCardHeader
        title={title}
        icon={icon}
        total={total}
        actions={<ScopePill label={scopeLabel} tooltip={scopeTooltip} />}
      />
      <ChartCardContent>
        {rows.length === 0 ? (
          <ChartEmpty message="Sin oportunidades en el periodo seleccionado" height={160} />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((row) => {
              const count = row[measure]
              // Visitas y ventas se leen mejor con su tasa sobre los registros
              // del mismo desarrollo: 12 ventas en 4 000 registros y 12 en 400
              // son historias distintas.
              const rate =
                measure === "registros" || row.registros === 0
                  ? null
                  : (count / row.registros) * 100
              return (
                <li key={row.desarrollo}>
                  <button
                    type="button"
                    onClick={() => openDrill(row)}
                    disabled={count === 0}
                    className="group grid w-full grid-cols-[minmax(5rem,7rem)_1fr_auto] items-center gap-2 rounded-sm px-1 py-0.5 text-left transition-colors enabled:hover:bg-muted/50 disabled:cursor-default"
                  >
                    <span
                      className={cn(
                        "truncate text-xs",
                        row.missing ? cn("italic", MISSING_TEXT) : "text-foreground"
                      )}
                      title={row.desarrollo}
                    >
                      {row.desarrollo}
                    </span>
                    <span className="h-4 w-full overflow-hidden rounded-sm bg-muted/60">
                      {count > 0 && (
                        <span
                          className="block h-full rounded-sm transition-[width] duration-300"
                          style={{
                            width: `${Math.max((count / max) * 100, 1.5)}%`,
                            backgroundColor: row.missing
                              ? "hsl(var(--muted-foreground))"
                              : BRAND_AMBER,
                            opacity: row.missing ? 0.35 : 1,
                          }}
                        />
                      )}
                    </span>
                    <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {count.toLocaleString("es-MX")}
                      </span>
                      {rate !== null && <> · {pctFmt.format(rate)}%</>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
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

/**
 * Los tres montajes concretos. Viven aquí para que la regla de cada recuento
 * —que es lo que explica el tooltip— exista una sola vez.
 */
type ConfiguredProps = Omit<
  DesarrolloCountsChartProps,
  "title" | "icon" | "measure" | "scopeLabel" | "scopeTooltip"
>

export function RegistrosPorDesarrolloChart(props: ConfiguredProps) {
  return (
    <DesarrolloCountsChart
      {...props}
      title="Registros por desarrollo"
      icon={Users}
      measure="registros"
      scopeLabel="Creadas"
      scopeTooltip={
        <>
          Cada oportunidad del CRM es un registro; se cuenta en el embudo de su desarrollo por
          la fecha en que se creó. Incluye las que llegaron por importación masiva (Palmyra y
          Zanda cargaron ~3 000 por CSV a fines de agosto de 2026), así que aquí no son solo
          leads de pauta.
        </>
      }
    />
  )
}

export function VisitasPorDesarrolloChart(props: ConfiguredProps) {
  return (
    <DesarrolloCountsChart
      {...props}
      title="Visitas por desarrollo"
      icon={Footprints}
      measure="visitas"
      scopeLabel="Etapa ≥ 05."
      scopeTooltip={
        <>
          Oportunidades cuya etapa actual es <strong>05. Visita al Desarrollo</strong> o
          posterior (Negociación, Apartado, Venta), o ganada: una venta implica visita. Una
          perdida que llegó hasta ahí sí visitó y cuenta. Es el mismo número que "Visitas
          realizadas" en el embudo. El porcentaje es sobre los registros del mismo desarrollo.
        </>
      }
    />
  )
}

export function VentasPorDesarrolloChart(props: ConfiguredProps) {
  return (
    <DesarrolloCountsChart
      {...props}
      title="Ventas por desarrollo"
      icon={Trophy}
      measure="ventas"
      scopeLabel="Ganadas"
      scopeTooltip={
        <>
          Oportunidades ganadas: con estatus <em>won</em> o en la etapa{" "}
          <strong>08. Venta</strong> sin estar perdidas. Se cuentan las dos señales porque en
          esta cuenta hay ventas registradas solo por etapa. El porcentaje es sobre los
          registros del mismo desarrollo.
        </>
      }
    />
  )
}
