"use client"

import { useMemo, useState } from "react"
import { TrendingDown } from "lucide-react"
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
import { CANAL_FIELDS, ORIGEN_FIELDS } from "@/lib/opportunity-breakdown"
import { buildLostReasonMatrix, type LostMatrixCell } from "@/lib/lost-reason-matrix"
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

/** Las dos dimensiones que el switch alterna. */
const DIMENSIONS = {
  canal: { label: "Canal de Contacto", fieldNames: CANAL_FIELDS },
  origen: { label: "Origen de Lead", fieldNames: ORIGEN_FIELDS },
} as const

type DimensionId = keyof typeof DIMENSIONS

// BRAND_AMBER en componentes, para poder variar el alpha del sombreado.
const HEAT_RGB = "245, 155, 27"

/**
 * Alpha del tinte de una celda. Raíz cuadrada y no lineal a propósito: en esta
 * cuenta un solo motivo ("No contesta") se lleva ~72% de las pérdidas, así que
 * una escala lineal dejaría toda la cola larga en blanco indistinguible.
 */
function heatAlpha(count: number, max: number): number {
  if (count === 0 || max === 0) return 0
  return Math.sqrt(count / max) * 0.55
}

/**
 * Motivos visibles con la tabla colapsada. Las filas vienen ordenadas de mayor a
 * menor, así que los diez primeros son los diez motivos que más pesan; el resto
 * es cola larga de una o dos oportunidades.
 */
const COLLAPSED_ROWS = 10

export interface LostReasonMatrixProps {
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
 * "Motivos de perdido": el cruce de por qué se pierde contra por dónde llegó el
 * lead, con un switch entre las dos dimensiones de llegada.
 *
 * Es la pregunta que ni el gráfico de estado (cuántas se pierden) ni los
 * rankings de categoría (de dónde vienen) contestan por separado: un lead de
 * Meta que llega por DM no se pierde por lo mismo que uno que llenó el
 * formulario del sitio.
 *
 * Los dos paneles montan el mismo componente; solo cambia el embudo.
 */
export function LostReasonMatrix({
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
}: LostReasonMatrixProps) {
  // Origen y canal viven en el CONTACTO en esta cuenta, no en la oportunidad, así
  // que la categoría se resuelve cruzando contra este mapa. Se arma sobre
  // allContacts (sin filtrar por fecha): la oportunidad que está en pantalla
  // puede colgar de un contacto creado fuera de la ventana, y perderlo la
  // mandaría a "Sin dato" por un accidente del filtro.
  const contactById = useMemo(
    () => new Map(allContacts.map((c) => [c.id, c])),
    [allContacts]
  )

  const [dimension, setDimension] = useState<DimensionId>("canal")
  const [expanded, setExpanded] = useState(false)
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]
  const dim = DIMENSIONS[dimension]

  const scoped = useMemo(
    () => scopeOpportunities(opportunities, panel, pipelines),
    [opportunities, panel, pipelines]
  )
  const matrix = useMemo(
    () => buildLostReasonMatrix(scoped, dim.fieldNames, contactById),
    [scoped, dim.fieldNames]
  )

  // La fila de totales SIEMPRE suma la matriz completa, esté colapsada o no: el
  // botón dice cuántos motivos y cuántas oportunidades quedan ocultos para que
  // la diferencia contra el total no parezca un descuadre.
  const { visibleRows, hiddenRows, hiddenTotal } = useMemo(() => {
    const hidden = matrix.rows.slice(COLLAPSED_ROWS)
    return {
      visibleRows: expanded ? matrix.rows : matrix.rows.slice(0, COLLAPSED_ROWS),
      hiddenRows: hidden.length,
      hiddenTotal: hidden.reduce((sum, r) => sum + r.total, 0),
    }
  }, [matrix.rows, expanded])

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  const openDrill = (cell: LostMatrixCell, title: string) => {
    if (cell.count === 0) return
    const items = cell.oppIds
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    if (items.length === 0) return
    setDrill({
      open: true,
      title,
      subtitle: `Oportunidades perdidas · embudo ${scope.label}`,
      opportunities: items,
    })
  }

  const stickyCol = "sticky left-0 z-20 bg-card"

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Motivos de perdido"
        icon={TrendingDown}
        total={matrix.grandTotal}
        actions={
          <>
            <div
              role="group"
              aria-label="Dimensión del cruce"
              className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted/40 p-0.5"
            >
              {(Object.keys(DIMENSIONS) as DimensionId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setDimension(id)}
                  aria-pressed={dimension === id}
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide transition-colors",
                    dimension === id
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {DIMENSIONS[id].label}
                </button>
              ))}
            </div>
            <ScopePill
              label="Perdidas y abandonadas"
              tooltip={
                <>
                  Motivo de pérdida de las oportunidades <strong>perdidas</strong> del embudo{" "}
                  {scope.label}, cruzado contra su <strong>{dim.label}</strong>. Las
                  abandonadas cuentan como pérdida, igual que en el gráfico de estado. Las
                  pocas oportunidades con dos categorías capturadas en la misma celda suman
                  en ambas columnas, así que la suma horizontal puede pasarse del{" "}
                  <em>Total</em> de la fila —que es el conteo de oportunidades distintas.
                </>
              }
            />
          </>
        }
      />
      <ChartCardContent>
        {matrix.rows.length === 0 ? (
          <ChartEmpty message="Sin oportunidades perdidas en el periodo seleccionado" />
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
                      Motivo de perdido
                    </th>
                    {matrix.columns.map((col) => (
                      <th
                        key={col.label}
                        className={cn(
                          "min-w-[6rem] border-b border-border px-3 py-2 font-medium",
                          col.missing ? cn("italic", MISSING_TEXT) : "text-muted-foreground"
                        )}
                      >
                        {col.label}
                      </th>
                    ))}
                    <th className="min-w-[4.5rem] border-b border-l border-border px-3 py-2 font-semibold">
                      Total
                    </th>
                    <th className="min-w-[4rem] border-b border-border px-3 py-2 font-medium text-muted-foreground">
                      %
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr key={row.label}>
                      <th
                        scope="row"
                        className={cn(
                          stickyCol,
                          "max-w-[16rem] truncate border-b border-r border-border px-3 py-1.5 text-left font-medium",
                          row.missing && cn("italic", MISSING_TEXT)
                        )}
                        title={row.label}
                      >
                        {row.label}
                      </th>
                      {row.cells.map((cell, i) => {
                        const col = matrix.columns[i]
                        return (
                          <td
                            key={col.label}
                            onClick={() =>
                              openDrill(cell, `${row.label} — ${col.label}`)
                            }
                            style={{
                              backgroundColor: `rgba(${HEAT_RGB}, ${heatAlpha(cell.count, matrix.maxCell)})`,
                            }}
                            className={cn(
                              "border-b border-border px-3 py-1.5",
                              cell.count > 0 && "cursor-pointer hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-primary/40"
                            )}
                          >
                            {cell.count === 0 ? (
                              <span className="text-muted-foreground">–</span>
                            ) : (
                              cell.count.toLocaleString("es-MX")
                            )}
                          </td>
                        )
                      })}
                      <td
                        onClick={() =>
                          openDrill(
                            { count: row.total, oppIds: row.oppIds },
                            `${row.label} — todas las categorías`
                          )
                        }
                        className="cursor-pointer border-b border-l border-border px-3 py-1.5 font-semibold hover:bg-muted/50"
                      >
                        {row.total.toLocaleString("es-MX")}
                      </td>
                      <td className="border-b border-border px-3 py-1.5 text-muted-foreground">
                        {pctFmt.format(row.pct)}%
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
                    {matrix.totals.map((cell, i) => (
                      <td
                        key={matrix.columns[i].label}
                        onClick={() =>
                          openDrill(cell, `Todos los motivos — ${matrix.columns[i].label}`)
                        }
                        className={cn(
                          "px-3 py-2",
                          cell.count > 0 && "cursor-pointer hover:bg-muted/50"
                        )}
                      >
                        {cell.count.toLocaleString("es-MX")}
                      </td>
                    ))}
                    <td className="border-l border-border px-3 py-2">
                      {matrix.grandTotal.toLocaleString("es-MX")}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">100.0%</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Fuera del contenedor con scroll horizontal: si viviera dentro, el
                botón se iría de la vista al desplazar la tabla a lo ancho. */}
            {hiddenRows > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="mt-2 w-full rounded-md px-2 py-1.5 text-center text-[11px] font-medium text-primary transition-colors hover:bg-muted/50"
              >
                {expanded
                  ? "Ver menos"
                  : `Ver ${hiddenRows} ${hiddenRows === 1 ? "motivo" : "motivos"} más · ${hiddenTotal.toLocaleString("es-MX")} ${hiddenTotal === 1 ? "oportunidad" : "oportunidades"} →`}
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
