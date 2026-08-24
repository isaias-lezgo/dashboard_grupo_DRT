"use client"

import { useMemo, useState } from "react"
import { Users } from "lucide-react"
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
  STATUS_BUCKETS,
  STATUS_LABELS,
  type StatusBucket,
} from "@/lib/opportunity-breakdown"
import {
  buildAdvisorMatrix,
  panelStageOrder,
  stageKind,
  type AdvisorCell,
  type AdvisorRow,
  type StageKind,
} from "@/lib/advisor-breakdown"
import { PANEL_SCOPES, scopeOpportunities, type PanelId } from "@/lib/panel-scope"
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

const pctFmt = new Intl.NumberFormat("es-MX", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

const n = (v: number) => v.toLocaleString("es-MX")

// Las mismas tres semánticas que "Oportunidades por estado", para que verde y
// rojo signifiquen lo mismo en toda la pestaña.
const BUCKET_COLORS: Record<StatusBucket, string> = {
  ganada: "#10b981",
  abierta: "#335577",
  perdida: "#ef4444",
}

/**
 * El tinte de una celda es secuencial —un solo tono, claro→oscuro— y el tono lo
 * decide el TIPO de etapa. Que las columnas no compartan tono es intencional:
 * cada una se normaliza contra su propio máximo, así que el color refuerza que
 * la comparación válida es vertical (¿quién tiene más en Propuesta?) y no
 * horizontal. Ámbar es la misma rampa que usa "Motivos de perdido".
 */
const STAGE_HEAT_RGB: Record<StageKind, string> = {
  abierto: "245, 155, 27", // BRAND_AMBER
  ganado: "16, 185, 129",
  perdido: "239, 68, 68",
}

/**
 * Alpha del tinte. Raíz cuadrada y no lineal, por lo mismo que en "Motivos de
 * perdido": la etapa Perdido se lleva la mayoría de los registros de cada asesor,
 * y en escala lineal el resto del embudo quedaría en blanco indistinguible.
 *
 * El segundo factor amortigua las columnas flacas. Normalizar por columna sin
 * él hace que en MESH un ÚNICO registro en "Cliente Futuro" —máximo de su
 * columna— se pinte tan fuerte como los 353 de "Perdido", y el ojo lo lee como
 * un foco rojo que no existe. Debajo de FULL_HEAT_MAX la columna entera se
 * atenúa; el orden dentro de ella no cambia.
 */
const FULL_HEAT_MAX = 8

function heatAlpha(count: number, max: number): number {
  if (count === 0 || max === 0) return 0
  const damp = Math.min(1, Math.sqrt(max / FULL_HEAT_MAX))
  return Math.sqrt(Math.min(count / max, 1)) * 0.55 * damp
}

/** Barra apilada del estatus de una fila. Cada segmento abre su propio drill. */
function StatusBar({
  row,
  onSegment,
}: {
  row: AdvisorRow
  onSegment: (bucket: StatusBucket) => void
}) {
  if (row.total === 0) return null
  return (
    <div className="flex h-2.5 w-full items-stretch gap-[2px]">
      {STATUS_BUCKETS.map((bucket) => {
        const count = row.status[bucket].count
        if (count === 0) return null
        return (
          <button
            key={bucket}
            type="button"
            onClick={() => onSegment(bucket)}
            title={`${STATUS_LABELS[bucket]}: ${n(count)} (${pctFmt.format((count / row.total) * 100)}%)`}
            aria-label={`${STATUS_LABELS[bucket]}: ${n(count)}`}
            style={{ flexGrow: count, backgroundColor: BUCKET_COLORS[bucket] }}
            // min-w para que una sola oportunidad ganada siga siendo visible al
            // lado de novecientas perdidas.
            className="min-w-[3px] rounded-[2px] transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          />
        )
      })}
    </div>
  )
}

export interface AdvisorStageTableProps {
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

/**
 * "Oportunidades por asesor": la matriz asesor × etapa del embudo, con el
 * desglose de estatus de cada asesor al lado.
 *
 * Contesta las dos preguntas de un jefe de ventas que el resto del panel deja
 * abiertas —dónde tiene parada su cartera cada quien, y en qué estatus— sin
 * tener que abrir el embudo persona por persona en el CRM.
 *
 * Los dos paneles montan el mismo componente; solo cambia el embudo.
 */
export function AdvisorStageTable({
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
}: AdvisorStageTableProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  const matrix = useMemo(() => {
    const scoped = scopeOpportunities(opportunities, panel, pipelines)
    return buildAdvisorMatrix(scoped, panelStageOrder(pipelines, panel))
  }, [opportunities, panel, pipelines])

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  const openDrill = (cell: AdvisorCell, title: string, note?: string) => {
    if (cell.count === 0) return
    const items = cell.oppIds
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    if (items.length === 0) return
    setDrill({
      open: true,
      title,
      subtitle: `Embudo ${scope.label}${note ? ` · ${note}` : ""}`,
      opportunities: items,
    })
  }

  const { stages, rows, totals, stageMax } = matrix
  const advisorCount = rows.filter((r) => !r.unassigned).length
  const stickyCol = "sticky left-0 z-20 bg-card"

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Oportunidades por asesor"
        icon={Users}
        total={totals.total}
        actions={
          <ScopePill
            label="Asesor × etapa"
            tooltip={
              <>
                Oportunidades del embudo <strong>{scope.label}</strong> creadas en el periodo,
                repartidas por el asesor asignado y por la etapa en la que están{" "}
                <em>hoy</em>. El sombreado compara <strong>dentro de cada columna</strong>,
                nunca entre columnas. La barra de estatus sigue la regla del panel:{" "}
                <strong>ganada</strong> incluye las que se registran moviéndolas a una etapa
                &ldquo;Ganado&rdquo; sin cambiar su estatus y <strong>perdida</strong> junta
                perdidas y abandonadas, así que puede no cuadrar con las columnas Ganado /
                Perdido cuando etapa y estatus se contradicen. Solo se listan los asesores con
                al menos una oportunidad en este embudo.
              </>
            }
          />
        }
      />
      <ChartCardContent>
        {totals.total === 0 ? (
          <ChartEmpty message="Sin oportunidades en el periodo seleccionado" />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              {STATUS_BUCKETS.map((bucket) => (
                <span key={bucket} className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: BUCKET_COLORS[bucket] }}
                    aria-hidden
                  />
                  {STATUS_LABELS[bucket]}
                </span>
              ))}
              <span className="ml-auto tabular-nums">
                {advisorCount} {advisorCount === 1 ? "asesor" : "asesores"} ·{" "}
                {n(totals.status.ganada.count)} ganadas de {n(totals.total)}
              </span>
            </div>

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
                      Asesor
                    </th>
                    {stages.map((stage) => (
                      <th
                        key={stage}
                        className="min-w-[5.5rem] border-b border-border px-3 py-2 font-medium text-muted-foreground"
                      >
                        {stage}
                      </th>
                    ))}
                    <th className="min-w-[4.5rem] border-b border-l border-border px-3 py-2 font-semibold">
                      Total
                    </th>
                    <th className="min-w-[8rem] border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">
                      Estatus
                    </th>
                    <th className="min-w-[5rem] border-b border-border px-3 py-2 font-medium text-muted-foreground">
                      % ganadas
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.advisor}>
                      <th
                        scope="row"
                        className={cn(
                          stickyCol,
                          "max-w-[14rem] truncate border-b border-r border-border px-3 py-1.5 text-left font-medium",
                          row.unassigned && cn("italic", MISSING_TEXT)
                        )}
                        title={row.advisor}
                      >
                        {row.advisor}
                      </th>

                      {stages.map((stage) => {
                        const cell = row.stages[stage] ?? { count: 0, oppIds: [] }
                        // "Sin asesor" no se tiñe: es otro orden de magnitud y
                        // saturaría la columna entera, que es justo lo que la
                        // normalización por columna intenta evitar.
                        const alpha = row.unassigned
                          ? 0
                          : heatAlpha(cell.count, stageMax[stage] ?? 0)
                        return (
                          <td
                            key={stage}
                            onClick={() =>
                              openDrill(cell, `${row.advisor} — ${stage}`, `${n(cell.count)} oportunidades`)
                            }
                            style={{
                              backgroundColor: `rgba(${STAGE_HEAT_RGB[stageKind(stage)]}, ${alpha})`,
                            }}
                            className={cn(
                              "border-b border-border px-3 py-1.5",
                              cell.count > 0 &&
                              "cursor-pointer hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-primary/40",
                              row.unassigned && "text-muted-foreground"
                            )}
                          >
                            {cell.count === 0 ? (
                              <span className="text-muted-foreground">–</span>
                            ) : (
                              n(cell.count)
                            )}
                          </td>
                        )
                      })}

                      <td
                        onClick={() =>
                          openDrill(
                            { count: row.total, oppIds: row.oppIds },
                            `${row.advisor} — todas las etapas`,
                            `${n(row.total)} oportunidades`
                          )
                        }
                        className={cn(
                          "cursor-pointer border-b border-l border-border px-3 py-1.5 font-semibold hover:bg-muted/50",
                          row.unassigned && "text-muted-foreground"
                        )}
                      >
                        {n(row.total)}
                      </td>

                      <td className="border-b border-border px-3 py-1.5">
                        <StatusBar
                          row={row}
                          onSegment={(bucket) =>
                            openDrill(
                              row.status[bucket],
                              `${row.advisor} — ${STATUS_LABELS[bucket]}`,
                              `${n(row.status[bucket].count)} oportunidades`
                            )
                          }
                        />
                      </td>

                      <td
                        className={cn(
                          "border-b border-border px-3 py-1.5",
                          row.unassigned ? "text-muted-foreground" : "text-foreground"
                        )}
                      >
                        {pctFmt.format(row.winRate)}%
                      </td>
                    </tr>
                  ))}

                  <tr className="font-semibold">
                    <th
                      scope="row"
                      className={cn(stickyCol, "border-r border-border px-3 py-2 text-left")}
                    >
                      Total
                    </th>
                    {stages.map((stage) => (
                      <td
                        key={stage}
                        onClick={() =>
                          openDrill(
                            totals.stages[stage],
                            `Todos los asesores — ${stage}`,
                            `${n(totals.stages[stage].count)} oportunidades`
                          )
                        }
                        className={cn(
                          "px-3 py-2",
                          totals.stages[stage].count > 0 && "cursor-pointer hover:bg-muted/50"
                        )}
                      >
                        {totals.stages[stage].count === 0 ? (
                          <span className="text-muted-foreground">–</span>
                        ) : (
                          n(totals.stages[stage].count)
                        )}
                      </td>
                    ))}
                    <td className="border-l border-border px-3 py-2">{n(totals.total)}</td>
                    <td className="px-3 py-2">
                      <StatusBar
                        row={totals}
                        onSegment={(bucket) =>
                          openDrill(
                            totals.status[bucket],
                            `Todos los asesores — ${STATUS_LABELS[bucket]}`,
                            `${n(totals.status[bucket].count)} oportunidades`
                          )
                        }
                      />
                    </td>
                    <td className="px-3 py-2">{pctFmt.format(totals.winRate)}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
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
