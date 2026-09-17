"use client"

import { useMemo, useState } from "react"
import { Megaphone } from "lucide-react"
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
  buildPautaPerformance,
  PAUTA_METRIC_LABELS,
  PAUTA_METRICS,
  type PautaCell,
  type PautaGroupBy,
  type PautaMetric,
  type PautaRelated,
} from "@/lib/pauta-performance"
import { PANEL_SCOPES, resolvePipelineId, scopeOpportunities, type PanelId } from "@/lib/panel-scope"
import { cn } from "@/lib/utils"
import {
  ChartCardContent,
  ChartCardHeader,
  ChartEmpty,
  DashboardCard,
  MISSING_TEXT,
  ScopePill,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"

const n = (v: number) => v.toLocaleString("es-MX")
const pctFmt = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 })

/**
 * Pautas visibles con la tabla colapsada. Vienen ordenadas por leads desc, así
 * que las doce primeras son las que de verdad traen volumen; en esta cuenta la
 * cola son ~100 nombres de una o dos oportunidades.
 */
const COLLAPSED_ROWS = 12

/** Las tres columnas que se leen contra "Leads recibidos". */
const RATE_METRICS: PautaMetric[] = ["citas", "ventas", "perdidos"]

/** Las dos identidades de una Pauta, y cuál lleva la fila en cada modo. */
const GROUPS: Record<PautaGroupBy, { toggle: string; key: string; related: string; empty: string }> = {
  name: { toggle: "Por nombre", key: "Nombre Pauta", related: "ID Pauta", empty: "Sin id" },
  id: { toggle: "Por ID", key: "ID Pauta", related: "Nombre Pauta", empty: "Sin nombre" },
}

/**
 * La otra identidad de la fila: el valor que más leads trae y cuántos más hay.
 * Un nombre de Pauta corre bajo varios anuncios (y un anuncio puede colgar de
 * varios nombres), así que un solo valor sería mentira y la lista completa no
 * cabe; la lista va en el `title`.
 */
function RelatedCell({ related, mono, empty }: { related: PautaRelated[]; mono: boolean; empty: string }) {
  if (related.length === 0) {
    return <span className={cn("italic", MISSING_TEXT)}>{empty}</span>
  }
  const [first, ...rest] = related
  // Un nombre puede correr bajo ~100 anuncios; el hover lista los diez que más
  // traen y resume el resto, o deja de ser un tooltip.
  const shown = related.slice(0, 10)
  const title = [
    ...shown.map((r) => `${r.label} · ${n(r.count)} ${r.count === 1 ? "lead" : "leads"}`),
    ...(related.length > shown.length ? [`… y ${n(related.length - shown.length)} más`] : []),
  ].join("\n")
  return (
    <span title={title} className={cn("inline-flex max-w-[22rem] items-baseline", mono && "font-mono text-[11px]")}>
      <span className="truncate">{first.label}</span>
      {rest.length > 0 && (
        <span className="ml-1 shrink-0 font-sans text-[10px] text-muted-foreground">+{rest.length}</span>
      )}
    </span>
  )
}

export interface PautaPerformanceTableProps {
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
  /** SIN filtrar: el registro Pauta pudo crearse fuera de la ventana de la oportunidad. */
  allPautas?: Pauta[]
  appointments?: Appointment[]
  /** SIN filtrar: la cita cuenta en cualquier fecha, como en el embudo de GENERAL. */
  allAppointments?: Appointment[]
  messages?: Message[]
  locationId?: string
}

/**
 * "Rendimiento por pauta": una fila por nombre de Pauta, con cuántas
 * oportunidades entraron por ella y cuántas llegaron a cita, se vendieron o se
 * perdieron. La Pauta se resuelve por CONTACTO (lib/pauta-performance.ts); la
 * unidad sigue siendo la oportunidad del embudo de la pestaña.
 */
export function PautaPerformanceTable({
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
  allAppointments = [],
  messages = [],
  locationId = "",
}: PautaPerformanceTableProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const [expanded, setExpanded] = useState(false)
  // Estado local de la tarjeta, no un filtro global: solo cambia cómo se agrupa.
  const [groupBy, setGroupBy] = useState<PautaGroupBy>("name")
  const scope = PANEL_SCOPES[panel]
  const group = GROUPS[groupBy]

  // El nombre real del pipeline de la pestaña (null en GENERAL): es lo que el
  // objeto Pauta escribe en `desarrollo`, así que acota qué Pautas nombran fila.
  const desarrollo = useMemo(() => {
    const id = resolvePipelineId(pipelines, panel)
    if (id === null) return null
    return pipelines.find((p) => p.id === id)?.name?.trim() || scope.label
  }, [pipelines, panel, scope.label])

  const perf = useMemo(
    () =>
      buildPautaPerformance(
        scopeOpportunities(opportunities, panel, pipelines),
        allPautas,
        allAppointments.length > 0 ? allAppointments : appointments,
        desarrollo,
        groupBy
      ),
    [opportunities, panel, pipelines, allPautas, allAppointments, appointments, desarrollo, groupBy]
  )

  const { visibleRows, hiddenRows, hiddenLeads } = useMemo(() => {
    const hidden = perf.rows.slice(COLLAPSED_ROWS)
    return {
      visibleRows: expanded ? perf.rows : perf.rows.slice(0, COLLAPSED_ROWS),
      hiddenRows: hidden.length,
      hiddenLeads: hidden.reduce((s, r) => s + r.cells.leads.count, 0),
    }
  }, [perf.rows, expanded])

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  const openDrill = (cell: PautaCell, title: string) => {
    if (cell.count === 0) return
    const items = cell.oppIds
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    if (items.length === 0) return
    setDrill({
      open: true,
      title,
      subtitle: `Embudo ${scope.label} · por pauta del contacto`,
      opportunities: items,
    })
  }

  const stickyCol = "sticky left-0 z-20 bg-card"

  const rate = (cell: PautaCell, leads: number) =>
    leads === 0 ? null : (cell.count / leads) * 100

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Rendimiento por pauta"
        icon={Megaphone}
        total={perf.totals.leads.count}
        actions={
          <>
            <div
              role="group"
              aria-label="Agrupar la tabla"
              className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted/40 p-0.5"
            >
              {(Object.keys(GROUPS) as PautaGroupBy[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setGroupBy(id)}
                  aria-pressed={groupBy === id}
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide transition-colors",
                    groupBy === id
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {GROUPS[id].toggle}
                </button>
              ))}
            </div>
          <ScopePill
            label="Pauta × resultado"
            tooltip={
              <>
                Cada fila es un{" "}
                {groupBy === "name" ? (
                  <>
                    <strong>nombre de Pauta</strong> del objeto Pautas
                  </>
                ) : (
                  <>
                    <strong>id de anuncio</strong> (campo <em>ID Pauta</em> de la oportunidad)
                  </>
                )}
                . Una
                oportunidad del embudo <strong>{scope.label}</strong> cae en la fila de la
                Pauta de su <strong>contacto</strong>: la Pauta no lleva oportunidad, así que
                el enlace es por contacto.{" "}
                {desarrollo ? (
                  <>
                    Solo cuentan las Pautas cuyo desarrollo es <strong>{desarrollo}</strong>;
                    un lead que entró por una pauta de otro desarrollo y después abrió
                    oportunidad aquí se reporta al pie, no en una fila.{" "}
                  </>
                ) : null}
                Nombre e id son uno-a-muchos — un nombre corre bajo varios anuncios — así
                que la columna <strong>{group.related}</strong> muestra el que más leads trae y
                cuántos más hay; los diez principales aparecen al pasar el cursor.{" "}
                <strong>Citas</strong> es etapa 04 o posterior, o
                una cita en el objeto Citas — la misma regla del embudo de GENERAL.{" "}
                <strong>Ventas</strong> es ganada; <strong>Perdidos</strong>, perdida o
                abandonada.{" "}
                {groupBy === "name" ? (
                  <>
                    Un contacto que entró por dos pautas cuenta en las dos filas; la fila{" "}
                    <em>Total</em> cuenta cada oportunidad una sola vez.{" "}
                  </>
                ) : (
                  <>Por id cada oportunidad cae en una sola fila. </>
                )}
                Las oportunidades sin ningún registro Pauta quedan fuera de la tabla en los dos
                modos y se reportan al pie.
              </>
            }
          />
          </>
        }
      />
      <ChartCardContent>
        {perf.rows.length === 0 ? (
          <ChartEmpty
            message={
              perf.universe === 0
                ? "Sin oportunidades en el periodo seleccionado"
                : "Ninguna oportunidad del periodo tiene registro de Pauta"
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-max min-w-full border-separate border-spacing-0 text-right text-xs tabular-nums">
                <thead>
                  <tr>
                    <th
                      className={cn(
                        stickyCol,
                        "border-b border-r border-border px-3 py-2 text-left font-semibold"
                      )}
                    >
                      {group.key}
                    </th>
                    <th className="min-w-[11rem] border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">
                      {group.related}
                    </th>
                    {PAUTA_METRICS.map((m) => (
                      <th
                        key={m}
                        className={cn(
                          "border-b border-border px-3 py-2",
                          m === "leads"
                            ? "min-w-[7rem] font-semibold"
                            : "min-w-[6.5rem] font-medium text-muted-foreground"
                        )}
                      >
                        {PAUTA_METRIC_LABELS[m]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const leads = row.cells.leads.count
                    return (
                      <tr key={row.name}>
                        <th
                          scope="row"
                          className={cn(
                            stickyCol,
                            "max-w-[22rem] truncate border-b border-r border-border px-3 py-1.5 text-left font-medium",
                            groupBy === "id" && !row.missing && "font-mono text-[11px]",
                            row.missing && cn("italic", MISSING_TEXT)
                          )}
                          title={row.name}
                        >
                          {row.name}
                        </th>
                        <td className="border-b border-border px-3 py-1.5 text-left">
                          <RelatedCell related={row.related} mono={groupBy === "name"} empty={group.empty} />
                        </td>
                        <td
                          onClick={() => openDrill(row.cells.leads, `${row.name} — leads recibidos`)}
                          className="cursor-pointer border-b border-border px-3 py-1.5 font-semibold hover:bg-muted/50"
                        >
                          {n(leads)}
                        </td>
                        {RATE_METRICS.map((m) => {
                          const cell = row.cells[m]
                          const r = rate(cell, leads)
                          return (
                            <td
                              key={m}
                              onClick={() =>
                                openDrill(cell, `${row.name} — ${PAUTA_METRIC_LABELS[m].toLowerCase()}`)
                              }
                              className={cn(
                                "border-b border-border px-3 py-1.5",
                                cell.count > 0 && "cursor-pointer hover:bg-muted/50"
                              )}
                            >
                              {cell.count === 0 ? (
                                <span className="text-muted-foreground">–</span>
                              ) : (
                                <>
                                  {n(cell.count)}
                                  {r !== null && (
                                    <span className="ml-1.5 text-[10px] text-muted-foreground">
                                      {pctFmt.format(r)}%
                                    </span>
                                  )}
                                </>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                  <tr className="font-semibold">
                    <th
                      scope="row"
                      className={cn(stickyCol, "border-r border-border px-3 py-2 text-left")}
                    >
                      Total
                    </th>
                    <td className="px-3 py-2" />
                    {PAUTA_METRICS.map((m) => {
                      const cell = perf.totals[m]
                      const r = m === "leads" ? null : rate(cell, perf.totals.leads.count)
                      return (
                        <td
                          key={m}
                          onClick={() =>
                            openDrill(cell, `Todas las pautas — ${PAUTA_METRIC_LABELS[m].toLowerCase()}`)
                          }
                          className={cn("px-3 py-2", cell.count > 0 && "cursor-pointer hover:bg-muted/50")}
                        >
                          {n(cell.count)}
                          {r !== null && cell.count > 0 && (
                            <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                              {pctFmt.format(r)}%
                            </span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Fuera del contenedor con scroll horizontal, como en "Motivos de
                perdido": dentro se iría de la vista al desplazar la tabla. */}
            {hiddenRows > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="mt-2 w-full rounded-md px-2 py-1.5 text-center text-[11px] font-medium text-primary transition-colors hover:bg-muted/50"
              >
                {expanded
                  ? "Ver menos"
                  : `Ver ${hiddenRows} ${groupBy === "id" ? (hiddenRows === 1 ? "id" : "ids") : hiddenRows === 1 ? "pauta" : "pautas"} más · ${n(hiddenLeads)} ${hiddenLeads === 1 ? "lead" : "leads"} →`}
              </button>
            )}

            <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
              {n(perf.totals.leads.count)} de {n(perf.universe)} oportunidades del periodo tienen
              registro de Pauta
              {perf.sinPauta.count > 0 && (
                <>
                  ; las{" "}
                  <button
                    type="button"
                    onClick={() => openDrill(perf.sinPauta, "Oportunidades sin registro de Pauta")}
                    className={cn("font-medium underline-offset-2 hover:underline", MISSING_TEXT)}
                  >
                    {n(perf.sinPauta.count)} sin Pauta
                  </button>{" "}
                  no aparecen en ninguna fila
                </>
              )}
              {perf.otroDesarrollo.count > 0 && (
                <>
                  {perf.sinPauta.count > 0 ? ", y otras " : "; "}
                  <button
                    type="button"
                    onClick={() =>
                      openDrill(perf.otroDesarrollo, `Con Pauta de otro desarrollo — embudo ${scope.label}`)
                    }
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {n(perf.otroDesarrollo.count)}
                  </button>{" "}
                  {perf.otroDesarrollo.count === 1 ? "entró" : "entraron"} por una pauta de{" "}
                  <strong>otro desarrollo</strong> y tampoco
                </>
              )}
              {perf.multiPauta > 0 && (
                <>
                  . {n(perf.multiPauta)}{" "}
                  {perf.multiPauta === 1 ? "oportunidad entró" : "oportunidades entraron"} por más de
                  una pauta y {perf.multiPauta === 1 ? "cuenta" : "cuentan"} en cada una; por eso
                  las filas pueden sumar más que el <em>Total</em>
                </>
              )}
              . Los porcentajes son sobre los leads de la fila.
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
