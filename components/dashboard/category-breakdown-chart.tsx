"use client"

import { useMemo, useState } from "react"
import { Compass, MessagesSquare, type LucideIcon } from "lucide-react"
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
  buildCategoryBreakdown,
  CANAL_FIELDS,
  NO_VALUE_LABEL,
  ORIGEN_FIELDS,
  type CategoryRow,
} from "@/lib/opportunity-breakdown"
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

export interface CategoryBreakdownChartProps {
  panel: PanelId
  title: string
  icon?: LucideIcon
  /**
   * Campos personalizados a leer, en orden de preferencia: el primero que traiga
   * valor gana (ver ORIGEN_FIELDS / CANAL_FIELDS).
   */
  fieldNames: string[]
  /** Texto del ScopePill que explica de dónde sale el dato. */
  scopeLabel: string
  scopeTooltip: React.ReactNode
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

export function CategoryBreakdownChart({
  panel,
  title,
  icon,
  fieldNames,
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
}: CategoryBreakdownChartProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  const scoped = useMemo(
    () => scopeOpportunities(opportunities, panel, pipelines),
    [opportunities, panel, pipelines]
  )
  const rows = useMemo(
    () => buildCategoryBreakdown(scoped, fieldNames),
    [scoped, fieldNames]
  )

  // Las barras se escalan contra la categoría más grande, no contra el total:
  // con Meta en 62% el resto quedaría en astillas ilegibles.
  const max = useMemo(() => Math.max(1, ...rows.map((r) => r.count)), [rows])

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  const openDrill = (row: CategoryRow) => {
    const items = row.oppIds
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    if (items.length === 0) return
    setDrill({
      open: true,
      title: `${title} — ${row.label}`,
      subtitle: `Embudo ${scope.label}`,
      opportunities: items,
    })
  }

  return (
    <DashboardCard>
      <ChartCardHeader
        title={title}
        icon={icon}
        total={scoped.length}
        actions={<ScopePill label={scopeLabel} tooltip={scopeTooltip} />}
      />
      <ChartCardContent>
        {rows.length === 0 ? (
          <ChartEmpty message="Sin oportunidades en el periodo seleccionado" />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((row) => {
              // "Sin dato" no es una categoría: es un hueco de captura. Va en el
              // rojizo de MISSING_TEXT, pero su barra sigue en gris — la barra
              // codifica volumen, no procedencia.
              const muted = row.label === NO_VALUE_LABEL
              return (
                <li key={row.label}>
                  <button
                    type="button"
                    onClick={() => openDrill(row)}
                    className="group grid w-full grid-cols-[minmax(6rem,9rem)_1fr_auto] items-center gap-2 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-muted/50"
                  >
                    <span
                      className={cn(
                        "truncate text-xs",
                        muted ? cn("italic", MISSING_TEXT) : "text-foreground"
                      )}
                      title={row.label}
                    >
                      {row.label}
                    </span>
                    <span className="h-4 w-full overflow-hidden rounded-sm bg-muted/60">
                      <span
                        className="block h-full rounded-sm transition-[width] duration-300"
                        style={{
                          width: `${Math.max((row.count / max) * 100, 1.5)}%`,
                          backgroundColor: muted ? "hsl(var(--muted-foreground))" : BRAND_AMBER,
                          opacity: muted ? 0.35 : 1,
                        }}
                      />
                    </span>
                    <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {row.count.toLocaleString("es-MX")}
                      </span>{" "}
                      · {pctFmt.format(row.pct)}%
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
 * Los dos montajes concretos del gráfico anterior.
 *
 * Viven aquí y no en cada panel para que el texto del tooltip —que es donde se
 * explica la normalización del texto libre— exista una sola vez: los dos paneles
 * rinden exactamente el mismo gráfico sobre embudos distintos.
 */
type ConfiguredProps = Omit<
  CategoryBreakdownChartProps,
  "title" | "icon" | "fieldNames" | "scopeLabel" | "scopeTooltip"
>

export function OrigenDeLeadChart(props: ConfiguredProps) {
  return (
    <CategoryBreakdownChart
      {...props}
      title="Oportunidades por Origen de Lead"
      icon={Compass}
      fieldNames={ORIGEN_FIELDS}
      scopeLabel="Origen de Lead"
      scopeTooltip={
        <>
          Campo <strong>Origen de Lead</strong> de la oportunidad; cuando viene vacío se lee el
          campo gemelo de lista. Es texto libre, así que las variantes de escritura se agrupan
          solas (<em>Walk-in</em> y <em>Walk In</em> son una sola fila). Las pocas oportunidades
          con dos orígenes en la misma celda cuentan en ambas barras, por lo que los porcentajes
          pueden pasar de 100 por unas décimas.
        </>
      }
    />
  )
}

export function CanalDeContactoChart(props: ConfiguredProps) {
  return (
    <CategoryBreakdownChart
      {...props}
      title="Oportunidades por Canal de Contacto"
      icon={MessagesSquare}
      fieldNames={CANAL_FIELDS}
      scopeLabel="Canal de Contacto"
      scopeTooltip={
        <>
          Campo <strong>Canal de Contacto</strong> de la oportunidad; cuando viene vacío se lee el
          campo gemelo de lista. Es el medio por el que llegó el contacto, no el origen del lead:
          un lead de Meta que escribió por WhatsApp aparece en <em>Meta</em> en el gráfico de al
          lado y en <em>WhatsApp</em> en éste.
        </>
      }
    />
  )
}
