"use client"

import { useMemo, useState } from "react"
import { BarChart3 } from "lucide-react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  XAxis,
  YAxis,
} from "recharts"
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
import { buildSalesSeries, type SalesSeriesEntry } from "@/lib/sales-series"
import {
  closeDateOf,
  NO_SERVICIO,
  NO_SUCURSAL,
  SERVICIO_FIELD,
} from "@/lib/sales-pivot"
import { PANEL_SCOPES, scopeOpportunities, type PanelId } from "@/lib/panel-scope"
import { filterByDateRange, type ResolvedDateRange } from "@/lib/date-range"
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
  ScopePill,
  SERIES_NEUTRALS,
  SERIES_PALETTE,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"

const money = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0,
})

/** Etiqueta sobre la barra y ticks del eje: $1.7 M en vez de $1,704,142. */
const moneyShort = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  notation: "compact",
  maximumFractionDigits: 1,
})

type Dimension = "sucursal" | "servicio"

/**
 * Serie invisible al tope del stack que ancla la etiqueta del total. No se puede
 * colgar la LabelList de la última serie real: si esa serie no tiene valor en un
 * mes, su rectángulo no se dibuja y la etiqueta de ESE mes desaparece.
 */
const TOTAL_ANCHOR = "__anchor"

/**
 * Esquinas del segmento que queda hasta arriba del stack. `Cell` tipa `radius`
 * como el atributo SVG (`string | number`), pero Recharts lo reenvía tal cual a
 * `Rectangle`, que sí entiende la tupla de cuatro esquinas — de ahí el cast.
 */
const TOP_RADIUS = [3, 3, 0, 0] as unknown as number

export interface SalesByDimensionChartProps {
  panel: PanelId
  dimension: Dimension
  /** Sin filtrar — este chart filtra por fecha de CIERRE, no por createdAt. */
  allOpportunities: Opportunity[]
  contacts: Contact[]
  /** Sin filtrar — los joins del drill se resuelven aquí. */
  allContacts: Contact[]
  pipelines?: Pipeline[]
  dateRange: ResolvedDateRange | null
  tasks?: Task[]
  calls?: Call[]
  allPautas?: Pauta[]
  appointments?: Appointment[]
  messages?: Message[]
  locationId?: string
}

/** Slot sintético por serie: sirve de dataKey y de nombre de variable CSS. */
function slotOf(entry: SalesSeriesEntry, namedIndex: number): string {
  if (entry.kind === "otros") return "otros"
  if (entry.kind === "empty") return "vacio"
  return `s${namedIndex}`
}

function colorOf(slot: string): { light: string; dark: string } {
  if (slot === "otros") return SERIES_NEUTRALS.otros
  if (slot === "vacio") return SERIES_NEUTRALS.empty
  const i = Number(slot.slice(1))
  return { light: SERIES_PALETTE.light[i], dark: SERIES_PALETTE.dark[i] }
}

export function SalesByDimensionChart({
  panel,
  dimension,
  allOpportunities,
  contacts,
  allContacts,
  pipelines = [],
  dateRange,
  tasks = [],
  calls = [],
  allPautas = [],
  appointments = [],
  messages = [],
  locationId = "",
}: SalesByDimensionChartProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  /** Slot aislado por la leyenda; null = todas visibles. */
  const [isolated, setIsolated] = useState<string | null>(null)

  const scope = PANEL_SCOPES[panel]
  const seriesOpts = useMemo(
    () =>
      dimension === "sucursal"
        ? { dimensionField: scope.sucursalField, emptyLabel: NO_SUCURSAL }
        : { dimensionField: SERVICIO_FIELD, emptyLabel: NO_SERVICIO },
    [dimension, scope.sucursalField]
  )

  const scoped = useMemo(
    () => scopeOpportunities(allOpportunities, panel, pipelines),
    [allOpportunities, panel, pipelines]
  )

  // Qué series existen y de qué color son se decide UNA vez sobre el set SIN
  // filtrar, y se impone a la llamada filtrada vía namedKeys. Si se decidiera
  // sobre el set filtrado, mover el filtro de fechas cambiaría qué serie se
  // pliega en "Otros" y repintaría las que sobreviven.
  const { slotByKey, namedKeys } = useMemo(() => {
    const all = buildSalesSeries(scoped, seriesOpts)
    const map = new Map<string, string>()
    const names: string[] = []
    let named = 0
    for (const s of all.series) {
      if (s.kind === "named") names.push(s.key)
      map.set(s.key, slotOf(s, s.kind === "named" ? named++ : 0))
    }
    return { slotByKey: map, namedKeys: names }
  }, [scoped, seriesOpts])

  const data = useMemo(
    () =>
      buildSalesSeries(filterByDateRange(scoped, closeDateOf, dateRange), {
        ...seriesOpts,
        namedKeys,
      }),
    [scoped, dateRange, seriesOpts, namedKeys]
  )

  // Serie → slot. Con namedKeys el mapa siempre acierta; el fallback solo evita
  // que un caso imprevisto rompa el render.
  const slots = useMemo(
    () => data.series.map((s) => ({ entry: s, slot: slotByKey.get(s.key) ?? "otros" })),
    [data.series, slotByKey]
  )

  const labelOf = (entry: SalesSeriesEntry) =>
    entry.kind === "otros" ? `Otros (${entry.foldedCount})` : entry.label

  const config: ChartConfig = useMemo(() => {
    const out: ChartConfig = {}
    for (const { entry, slot } of slots) {
      out[slot] = { label: labelOf(entry), theme: colorOf(slot) }
    }
    return out
  }, [slots])

  // Recharts consume filas planas: una por mes, con un dataKey por slot. Las
  // series sin valor en un mes se dejan AUSENTES, no en cero — un cero mete un
  // rectángulo de altura 0 en el stack, que además desordena el cálculo de qué
  // segmento queda hasta arriba (topSlotByRow).
  const rows = useMemo(
    () =>
      data.buckets.map((b) => {
        const row: Record<string, string | number> = {
          // "Sin fecha de cierre" completo no cabe en el último tick: se sale
          // de la tarjeta. La nota al pie lo dice con todas sus letras.
          label: b.kind === "no-date" ? "Sin fecha" : b.label,
          total: b.total,
          [TOTAL_ANCHOR]: 0,
        }
        for (const { entry, slot } of slots) {
          const v = b.values[entry.key]
          if (v) row[slot] = v
        }
        return row
      }),
    [data.buckets, slots]
  )

  // Slot que queda hasta arriba del stack en CADA barra: es el único que lleva
  // esquinas redondeadas, igual que los demás charts. No se puede fijar en la
  // última serie renderizada — en un mes donde esa serie no tiene valor, su
  // rectángulo no existe y esa barra se quedaría con el tope cuadrado.
  const topSlotByRow = useMemo(
    () =>
      rows.map((row) => {
        let top: string | null = null
        for (const { slot } of slots) if (row[slot]) top = slot
        return top
      }),
    [rows, slots]
  )

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  const openDrill = (seriesKey: string, bucketIndex: number) => {
    const bucket = data.buckets[bucketIndex]
    const ids = bucket?.oppIds[seriesKey] ?? []
    if (ids.length === 0) return
    const opportunities = ids
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    setDrill({
      open: true,
      title: `${bucket.label} — ${seriesKey}`,
      subtitle: "Oportunidades ganadas",
      opportunities,
    })
  }

  const dimLabel = dimension === "sucursal" ? "sucursal" : "servicio"
  const noDateTotal = data.buckets.find((b) => b.kind === "no-date")?.total ?? 0

  // ChartStyle emite `--color-<slot>` bajo el selector [data-chart=chart-<id>],
  // y la leyenda vive FUERA del ChartContainer, donde esas variables no
  // existirían. Marcar el bloque de chips con el MISMO data-chart las trae —
  // el <style> es global, solo hay que estar dentro de su selector.
  const chartId = `ventas-${panel}-${dimension}`

  return (
    <DashboardCard>
      <ChartCardHeader
        title={`Ventas por ${dimLabel}`}
        icon={BarChart3}
        total={money.format(data.grandTotal)}
        actions={
          <ScopePill
            label="Ganadas · por fecha de cierre"
            tooltip={
              <>
                Suma el valor de las oportunidades <strong>ganadas</strong> del embudo{" "}
                {scope.label}, apiladas por <strong>{dimLabel}</strong> y agrupadas por el
                mes de su <strong>Fecha de Cierre</strong> (no por su fecha de creación).
                Las que no tienen {dimLabel} capturado caen en el segmento gris, y las que
                no tienen fecha de cierre viven en la barra <em>Sin fecha de cierre</em>,
                al final del eje, que no se ve afectada por el filtro de fechas. Los
                totales cuadran con la tabla de arriba.
              </>
            }
          />
        }
      />
      <ChartCardContent>
        {rows.length === 0 ? (
          <ChartEmpty message="Sin ventas cerradas en el periodo seleccionado" />
        ) : (
          <>
            <div
              data-chart={`chart-${chartId}`}
              className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1"
            >
              {slots.map(({ entry, slot }) => {
                const dimmed = isolated !== null && isolated !== slot
                return (
                  <button
                    key={slot}
                    type="button"
                    onClick={() => setIsolated(isolated === slot ? null : slot)}
                    className={cn(
                      "inline-flex min-w-0 max-w-[12rem] items-center gap-1.5 text-[11px] text-muted-foreground transition-opacity",
                      dimmed && "opacity-40"
                    )}
                    title={`${entry.label} · ${money.format(entry.total)}`}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: `var(--color-${slot})` }}
                      aria-hidden
                    />
                    {/* La serie "Sin sucursal" / "Sin servicio" lleva la
                        etiqueta en rojizo, pero su muestra de color sigue en el
                        gris de SERIES_NEUTRALS: ese cuadro tiene que casar con
                        el segmento del stack. */}
                    <span className={cn("truncate", entry.kind === "empty" && MISSING_TEXT)}>
                      {labelOf(entry)}
                    </span>
                  </button>
                )
              })}
            </div>

            <ChartContainer id={chartId} config={config} className="h-[280px] w-full">
              {/* Mismos márgenes que los demás charts, salvo el superior: ahí
                  vive la etiqueta del total de cada barra, y con 5px se recorta
                  sobre la barra más alta. */}
              <BarChart data={rows} margin={{ top: 24, right: 8, left: 0, bottom: 5 }}>
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
                  tick={CHART_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  tickFormatter={(v: number) => moneyShort.format(v)}
                />
                <ChartTooltip
                  content={
                    <NonZeroTooltipContent
                      // El formatter reemplaza la fila COMPLETA, así que aquí se
                      // vuelve a dibujar el punto de color y la etiqueta: sin
                      // ellos un tooltip de barra apilada no dice de qué serie
                      // es cada monto.
                      formatter={(value, name) => (
                        <div className="flex w-full items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: `var(--color-${name})` }}
                            aria-hidden
                          />
                          <span className="flex-1 truncate text-muted-foreground">
                            {config[String(name)]?.label ?? name}
                          </span>
                          <span className="font-mono font-medium tabular-nums text-foreground">
                            {money.format(Number(value))}
                          </span>
                        </div>
                      )}
                    />
                  }
                />
                {slots.map(({ entry, slot }) => (
                  <Bar
                    key={slot}
                    dataKey={slot}
                    stackId="ventas"
                    fill={`var(--color-${slot})`}
                    // Sin trazo separador: el apilado va continuo. Los tonos de
                    // SERIES_PALETTE ya están validados por PARES —cualquier
                    // combinación de la leyenda, no solo las vecinas— así que
                    // dos segmentos contiguos se distinguen sin una línea de por
                    // medio, y la barra se lee como un solo total.
                    onClick={(_: unknown, index: number) => openDrill(entry.key, index)}
                    className="cursor-pointer"
                  >
                    {rows.map((_, rowIndex) => {
                      // La barra "Sin fecha de cierre" va atenuada: no es un mes,
                      // y el eje no debe sugerir que sí.
                      const noDate = data.buckets[rowIndex].kind === "no-date"
                      const dimmed = isolated !== null && isolated !== slot
                      return (
                        <Cell
                          key={rowIndex}
                          fillOpacity={(noDate ? 0.55 : 1) * (dimmed ? 0.18 : 1)}
                          radius={topSlotByRow[rowIndex] === slot ? TOP_RADIUS : undefined}
                        />
                      )
                    })}
                  </Bar>
                ))}
                <Bar dataKey={TOTAL_ANCHOR} stackId="ventas" fill="transparent">
                  <LabelList
                    dataKey="total"
                    position="top"
                    offset={8}
                    className="fill-muted-foreground"
                    fontSize={10}
                    formatter={(v: number) => moneyShort.format(v)}
                  />
                </Bar>
              </BarChart>
            </ChartContainer>

            {noDateTotal > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                La última barra agrupa {money.format(noDateTotal)} en ventas ganadas sin
                Fecha de Cierre capturada.
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
