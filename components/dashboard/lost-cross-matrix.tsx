"use client"

import { useMemo, useState } from "react"
import { LayoutGrid } from "lucide-react"
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
  buildLostCrossMatrix,
  LOST_DIMENSIONS,
  LOST_DIMENSION_IDS,
  type LostCrossCell,
  type LostDimensionId,
} from "@/lib/lost-cross-matrix"
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

// BRAND_AMBER en componentes, para poder variar el alpha del sombreado.
const HEAT_RGB = "245, 155, 27"

/**
 * Alpha del tinte de una celda. Raíz cuadrada y no lineal, por la misma razón
 * que en "Motivos de perdido": en esta cuenta una sola categoría ("Meta" en
 * origen, "DM" en canal) se lleva ~78% de las pérdidas, así que una escala
 * lineal dejaría toda la cola larga en blanco indistinguible.
 *
 * `sentinel` apaga el tinte en las filas y columnas de captura faltante: su
 * conteo ya quedó fuera de `maxCell`, y pintarlas igual las haría leer como la
 * celda más caliente de la tabla cuando lo que dicen es que el dato no está.
 */
function heatAlpha(count: number, max: number, sentinel: boolean): number {
  if (sentinel || count === 0 || max === 0) return 0
  return Math.min(1, Math.sqrt(count / max)) * 0.55
}

/**
 * Filas visibles con la tabla colapsada. Vienen ordenadas de mayor a menor, así
 * que las diez primeras son las que más pesan; el resto es cola larga.
 */
const COLLAPSED_ROWS = 10

const DEFAULT_ROW: LostDimensionId = "desarrollo"
const DEFAULT_COL: LostDimensionId = "canal"

/** Un grupo de botones de eje. Mismo chrome que el switch de "Motivos de perdido". */
function AxisSwitch({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: LostDimensionId
  options: LostDimensionId[]
  onChange: (id: LostDimensionId) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div
        role="group"
        aria-label={`Dimensión de ${label.toLowerCase()}`}
        className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted/40 p-0.5"
      >
        {options.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={value === id}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide transition-colors",
              value === id
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {LOST_DIMENSIONS[id].label}
          </button>
        ))}
      </div>
    </div>
  )
}

export interface LostCrossMatrixProps {
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
 * "Perdidas por servicio, origen y canal": el mismo conjunto de oportunidades
 * perdidas visto sobre cualquier par de esas tres dimensiones.
 *
 * Va más allá de "Motivos de perdido", que contesta POR QUÉ se pierde: aquí la
 * pregunta es QUÉ se estaba vendiendo y POR DÓNDE llegó quien no compró — un
 * lead de Meta que preguntó por una sala de juntas no se pierde por lo mismo
 * que uno que llegó caminando a preguntar por oficina privada.
 *
 * Los dos paneles montan el mismo componente; solo cambia el embudo.
 */
export function LostCrossMatrix({
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
}: LostCrossMatrixProps) {
  const [rowDim, setRowDim] = useState<LostDimensionId>(DEFAULT_ROW)
  const [colDim, setColDim] = useState<LostDimensionId>(DEFAULT_COL)
  const [expanded, setExpanded] = useState(false)
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  // Elegir en un eje la dimensión que ya vivía en el otro TRANSPONE la tabla, en
  // vez de mandar al otro eje a una tercera dimensión que nadie pidió: así el
  // clic siempre hace lo que se ve venir, y ningún par queda inalcanzable.
  const pickRow = (id: LostDimensionId) => {
    if (id === colDim) setColDim(rowDim)
    setRowDim(id)
  }
  const pickCol = (id: LostDimensionId) => {
    if (id === rowDim) setRowDim(colDim)
    setColDim(id)
  }

  const scoped = useMemo(
    () => scopeOpportunities(opportunities, panel, pipelines),
    [opportunities, panel, pipelines]
  )
  const matrix = useMemo(
    () => buildLostCrossMatrix(scoped, rowDim, colDim, pipelines),
    [scoped, rowDim, colDim, pipelines]
  )

  // La fila de totales SIEMPRE suma la matriz completa, esté colapsada o no: el
  // botón dice cuántas filas y cuántas oportunidades quedan ocultas para que la
  // diferencia contra el total no parezca un descuadre.
  //
  // La cubeta centinela queda FUERA del colapso y siempre se pinta: va al final
  // por orden, pero en este cruce es donde vive el hallazgo —"Sin servicio" se
  // lleva el 89%— y la nota al pie la nombra. Esconderla tras un "ver más"
  // dejaría la nota hablando de una fila que no está en pantalla.
  const { visibleRows, hiddenRows, hiddenTotal } = useMemo(() => {
    const real = matrix.rows.filter((r) => !r.missing)
    const sentinel = matrix.rows.filter((r) => r.missing)
    const hidden = expanded ? [] : real.slice(COLLAPSED_ROWS)
    const shown = expanded ? real : real.slice(0, COLLAPSED_ROWS)
    return {
      visibleRows: [...shown, ...sentinel],
      hiddenRows: hidden.length,
      hiddenTotal: hidden.reduce((sum, r) => sum + r.total, 0),
    }
  }, [matrix.rows, expanded])

  /**
   * Cuántas perdidas no resuelven su desarrollo, si Desarrollo está en algún eje.
   *
   * A diferencia del campo que ocupaba este lugar antes, el desarrollo sale del
   * EMBUDO y está poblado al 100%, así que esta nota normalmente NO aparece. Si
   * aparece, no es un hueco de captura del equipo de ventas: significa que hay
   * oportunidades en un embudo que el sync no trajo o que se borró del CRM, y
   * eso se revisa en GHL, no en la tarjeta.
   */
  const desarrolloGap = useMemo(() => {
    if (matrix.grandTotal === 0) return null
    if (rowDim === "desarrollo") {
      const row = matrix.rows.find((r) => r.missing)
      return row ? row.total : 0
    }
    if (colDim === "desarrollo") {
      const col = matrix.columns.find((c) => c.missing)
      return col ? col.total : 0
    }
    return null
  }, [matrix, rowDim, colDim])

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  const openDrill = (cell: LostCrossCell, title: string) => {
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
  const colOptions = LOST_DIMENSION_IDS.filter((id) => id !== rowDim)

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Perdidas por servicio, origen y canal"
        icon={LayoutGrid}
        total={matrix.grandTotal}
        actions={
          <ScopePill
            label="Perdidas y abandonadas"
            tooltip={
              <>
                Las oportunidades <strong>perdidas</strong> del embudo {scope.label},
                cruzadas sobre dos de las tres dimensiones. Las abandonadas cuentan como
                pérdida, igual que en el gráfico de estado. Las pocas oportunidades con
                dos categorías capturadas en la misma celda suman en cada una, así que
                las sumas cruzadas pueden pasarse de los totales —que son conteos de
                oportunidades <em>distintas</em>.
              </>
            }
          />
        }
      />
      <ChartCardContent>
        {/* Los dos switches viven aquí y no en el encabezado: con la píldora de
            alcance al lado, tres controles en una sola línea se apretaban. */}
        <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          <AxisSwitch
            label="Filas"
            value={rowDim}
            options={LOST_DIMENSION_IDS}
            onChange={pickRow}
          />
          <AxisSwitch
            label="Columnas"
            value={colDim}
            options={colOptions}
            onChange={pickCol}
          />
        </div>

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
                      {LOST_DIMENSIONS[rowDim].label}
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
                            onClick={() => openDrill(cell, `${row.label} — ${col.label}`)}
                            style={{
                              backgroundColor: `rgba(${HEAT_RGB}, ${heatAlpha(
                                cell.count,
                                matrix.maxCell,
                                row.missing || col.missing
                              )})`,
                            }}
                            className={cn(
                              "border-b border-border px-3 py-1.5",
                              cell.count > 0 &&
                                "cursor-pointer hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-primary/40"
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
                            `${row.label} — todo ${LOST_DIMENSIONS[colDim].label}`
                          )
                        }
                        className="cursor-pointer border-b border-l border-border px-3 py-1.5 font-semibold hover:bg-muted/50"
                      >
                        {n(row.total)}
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
                          openDrill(
                            cell,
                            `Todo ${LOST_DIMENSIONS[rowDim].label} — ${matrix.columns[i].label}`
                          )
                        }
                        className={cn(
                          "px-3 py-2",
                          cell.count > 0 && "cursor-pointer hover:bg-muted/50"
                        )}
                      >
                        {n(cell.count)}
                      </td>
                    ))}
                    <td className="border-l border-border px-3 py-2">{n(matrix.grandTotal)}</td>
                    <td className="px-3 py-2 text-muted-foreground">100.0%</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Fuera del contenedor con scroll horizontal: si vivieran dentro, el
                botón y la nota se irían de la vista al desplazar la tabla. */}
            {hiddenRows > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="mt-2 w-full rounded-md px-2 py-1.5 text-center text-[11px] font-medium text-primary transition-colors hover:bg-muted/50"
              >
                {expanded
                  ? "Ver menos"
                  : `Ver ${hiddenRows} ${hiddenRows === 1 ? "fila" : "filas"} más · ${n(hiddenTotal)} ${hiddenTotal === 1 ? "oportunidad" : "oportunidades"} →`}
              </button>
            )}

            {desarrolloGap !== null && desarrolloGap > 0 && (
              <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
                {n(desarrolloGap)} de {n(matrix.grandTotal)} perdidas{" "}
                ({pctFmt.format((desarrolloGap / matrix.grandTotal) * 100)}%) están en un
                embudo que no resuelve su{" "}
                <span className={cn("font-medium", MISSING_TEXT)}>desarrollo</span>. El
                desarrollo sale del embudo y debería estar siempre: revísalo en GHL.
              </p>
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
