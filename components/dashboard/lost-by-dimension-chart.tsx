"use client"

import { useMemo, useState } from "react"
import { TrendingDown } from "lucide-react"
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
import { NO_SERVICIO, NO_SUCURSAL, SERVICIO_FIELD } from "@/lib/sales-pivot"
import { monthKeyOf as createdMonthKeyOf, statusBucket } from "@/lib/opportunity-breakdown"
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
  ScopePill,
  SERIES_NEUTRALS,
  SERIES_PALETTE,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"

const n = (v: number) => v.toLocaleString("es-MX")

/** Misma lectura que hace buildSalesSeries del custom field de la dimensión. */
function cfString(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v
  return (s ?? "").trim()
}

type Dimension = "sucursal" | "servicio"

/**
 * Qué cuenta como "no ganado".
 *
 * Son dos preguntas distintas y por eso son un switch y no un default: "perdidas"
 * mide un desenlace cerrado —es el espejo exacto de "Ventas por servicio" y sus
 * totales cuadran con la tabla "Perdidas por servicio, origen y canal"—, mientras
 * que "no ganadas" suma las que siguen abiertas, o sea toda la demanda del mes
 * que todavía no se convirtió. En el eje de esta gráfica, que es el mes en que
 * NOS BUSCARON, los meses recientes se ven altos en ese segundo modo por una
 * razón legítima: esos leads siguen vivos.
 */
type Universe = "perdidas" | "no-ganadas"

const UNIVERSES: Record<Universe, { label: string; noun: string; includes: (o: Opportunity) => boolean }> = {
  perdidas: {
    label: "Perdidas",
    noun: "leads perdidos",
    includes: (o) => statusBucket(o) === "perdida",
  },
  "no-ganadas": {
    label: "No ganadas",
    noun: "leads no ganados",
    includes: (o) => statusBucket(o) !== "ganada",
  },
}

const UNIVERSE_IDS = Object.keys(UNIVERSES) as Universe[]

/**
 * Serie invisible al tope del stack que ancla la etiqueta del total. No se puede
 * colgar la LabelList de la última serie real: si esa serie no tiene valor en un
 * mes, su rectángulo no se dibuja y la etiqueta de ESE mes desaparece.
 */
const TOTAL_ANCHOR = "__anchor"

/** Ver la nota equivalente en sales-by-dimension-chart.tsx. */
const TOP_RADIUS = [3, 3, 0, 0] as unknown as number

export interface LostByDimensionChartProps {
  panel: PanelId
  dimension: Dimension
  /** Ya filtradas por fecha de creación y por el toggle de HubSpot. */
  opportunities: Opportunity[]
  /** Sin filtrar — de aquí salen los colores estables y los joins del drill. */
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

/** El mismo chrome que el switch de "Motivos de perdido" y el de "Perdidas por…". */
function UniverseSwitch({
  value,
  onChange,
}: {
  value: Universe
  onChange: (id: Universe) => void
}) {
  return (
    <div
      role="group"
      aria-label="Universo de leads"
      className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted/40 p-0.5"
    >
      {UNIVERSE_IDS.map((id) => (
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
          {UNIVERSES[id].label}
        </button>
      ))}
    </div>
  )
}

/**
 * Prende y apaga la cubeta sin dato capturado dentro del apilado. Va rotulada en
 * el rojizo de MISSING_TEXT cuando está prendida, igual que la etiqueta de esa
 * serie en la leyenda: no es una categoría del negocio, es un hueco en el CRM.
 */
function MissingToggle({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      aria-pressed={value}
      title={
        value
          ? `Quitar "${label}" del apilado — se come la gráfica`
          : `Incluir "${label}" en el apilado`
      }
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium tracking-wide transition-colors",
        value
          ? "bg-card shadow-sm"
          : "bg-muted/40 text-muted-foreground hover:text-foreground"
      )}
    >
      <span
        className={cn(
          "h-2.5 w-2.5 shrink-0 rounded-sm border",
          value ? "border-transparent bg-[#9ca3af]" : "border-border"
        )}
        aria-hidden
      />
      <span className={cn(value && MISSING_TEXT)}>{label}</span>
    </button>
  )
}

export function LostByDimensionChart({
  panel,
  dimension,
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
}: LostByDimensionChartProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const [universe, setUniverse] = useState<Universe>("no-ganadas")
  /** Apagado: la cubeta sin dato capturado vive en la nota, no en el apilado. */
  const [showEmpty, setShowEmpty] = useState(false)
  /** Slot aislado por la leyenda; null = todas visibles. */
  const [isolated, setIsolated] = useState<string | null>(null)

  const scope = PANEL_SCOPES[panel]
  const dimOpts = useMemo(
    () =>
      dimension === "sucursal"
        ? { dimensionField: scope.sucursalField, emptyLabel: NO_SUCURSAL }
        : { dimensionField: SERVICIO_FIELD, emptyLabel: NO_SERVICIO },
    [dimension, scope.sucursalField]
  )

  // El mes es el de CREACIÓN: la pregunta que contesta esta tarjeta es cuántos
  // nos buscaron en el mes y no compraron. Un lead perdido nunca tiene Fecha de
  // Cierre, así que el eje de la gráfica de ventas aquí no existiría. Se lee con
  // el lector LOCAL de opportunity-breakdown, el mismo que usa "Oportunidades
  // por estado", para que las dos gráficas pongan cada lead en el mismo mes.
  const monthOf = useMemo(() => (o: Opportunity) => createdMonthKeyOf(o.createdAt), [])

  // La cubeta "Sin servicio" entra al apilado solo si el usuario la pide, y
  // arranca APAGADA. Con ~89% de los leads sin el campo capturado, ese segmento
  // gris se come la gráfica entera y los productos reales quedan en franjas de
  // un pixel: un apilado que solo se puede leer como "casi todo es gris" no
  // informa de nada. Apagada, el dato no se esconde — cambia de lugar, a la nota
  // al pie, que lo dice en números absolutos y es donde sí se lee.
  //
  // Consecuencia deliberada de apagarla: el total del encabezado y las etiquetas
  // sobre cada barra cuentan SOLO los leads con la dimensión capturada, para que
  // el número diga exactamente lo que está dibujado.
  const hasDim = useMemo(
    () => (o: Opportunity) =>
      cfString(o.customFieldsResolved?.[dimOpts.dimensionField]) !== "",
    [dimOpts.dimensionField]
  )

  const scopedAll = useMemo(
    () => scopeOpportunities(allOpportunities, panel, pipelines),
    [allOpportunities, panel, pipelines]
  )
  const scoped = useMemo(
    () => scopeOpportunities(opportunities, panel, pipelines),
    [opportunities, panel, pipelines]
  )

  // Qué series existen y de qué color son se decide UNA vez, sobre el set SIN
  // filtrar y SIEMPRE en el universo más amplio ("no ganadas"). Lo primero evita
  // que mover el filtro de fechas repinte las series; lo segundo evita lo mismo
  // al tocar el switch — un servicio que solo pesa entre las abiertas se
  // quedaría con nombre propio en un modo y caería en "Otros" en el otro.
  const { slotByKey, namedKeys } = useMemo(() => {
    const all = buildSalesSeries(scopedAll, {
      ...dimOpts,
      include: UNIVERSES["no-ganadas"].includes,
      monthOf,
      measure: "count",
    })
    const map = new Map<string, string>()
    const names: string[] = []
    let named = 0
    for (const s of all.series) {
      if (s.kind === "named") names.push(s.key)
      map.set(s.key, slotOf(s, s.kind === "named" ? named++ : 0))
    }
    return { slotByKey: map, namedKeys: names }
  }, [scopedAll, dimOpts, monthOf])

  const data = useMemo(
    () =>
      buildSalesSeries(scoped, {
        ...dimOpts,
        include: (o) => UNIVERSES[universe].includes(o) && (showEmpty || hasDim(o)),
        monthOf,
        measure: "count",
        namedKeys,
      }),
    [scoped, dimOpts, universe, showEmpty, monthOf, namedKeys, hasDim]
  )

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
  // rectángulo de altura 0 en el stack y desordena el cálculo de topSlotByRow.
  const rows = useMemo(
    () =>
      data.buckets.map((b) => {
        const row: Record<string, string | number> = {
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
    const list = ids
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    setDrill({
      open: true,
      title: `${bucket.label} — ${seriesKey}`,
      subtitle: `Oportunidades ${universe === "perdidas" ? "perdidas" : "no ganadas"}`,
      opportunities: list,
    })
  }

  const dimLabel = dimension === "sucursal" ? "sucursal" : "servicio"
  const dimField = dimension === "sucursal" ? scope.sucursalField : SERVICIO_FIELD
  const universeCfg = UNIVERSES[universe]

  // El hueco de captura, en los números del periodo que está en pantalla. Es lo
  // que de verdad entrega esta tarjeta hoy: `Servicio` se llena al PERFILAR el
  // lead (medido contra producción el 2026-08-23: 0/32 en Nuevo Lead, 1/49 en
  // Lead en proceso, 12/13 en Lead Perfilado, 100/100 en ganadas, 1/100 en
  // perdidas), y un lead que se cayó antes de perfilarse nunca dijo qué quería.
  // La cubeta va DENTRO del apilado y con su nota debajo — esconderla dejaría
  // una gráfica que parece decir algo del negocio cuando lo que dice es que el
  // dato no se está capturando.
  // Ojo: estas dos NO salen de `data`, que ya viene recortado por el toggle.
  // Salen del universo completo, para que la nota diga lo mismo esté el toggle
  // prendido o apagado — es el número que el cliente tiene que ir a arreglar en
  // GHL, y no puede depender de cómo esté configurada la vista.
  const { universeTotal, missingTotal } = useMemo(() => {
    let universeTotal = 0
    let missingTotal = 0
    for (const o of scoped) {
      if (!UNIVERSES[universe].includes(o)) continue
      universeTotal += 1
      if (!hasDim(o)) missingTotal += 1
    }
    return { universeTotal, missingTotal }
  }, [scoped, universe, hasDim])
  const missingPct = universeTotal > 0 ? (missingTotal / universeTotal) * 100 : 0
  const noDateTotal = data.buckets.find((b) => b.kind === "no-date")?.total ?? 0

  // ChartStyle emite `--color-<slot>` bajo [data-chart=chart-<id>], y la leyenda
  // vive FUERA del ChartContainer. Marcar los chips con el MISMO data-chart trae
  // esas variables: el <style> es global, solo hay que estar dentro del selector.
  const chartId = `no-ganados-${panel}-${dimension}`

  return (
    <DashboardCard>
      <ChartCardHeader
        title={`Leads no ganados por ${dimLabel}`}
        icon={TrendingDown}
        total={n(data.grandTotal)}
        actions={
          <>
            <UniverseSwitch value={universe} onChange={setUniverse} />
            <MissingToggle
              label={dimOpts.emptyLabel}
              value={showEmpty}
              onChange={setShowEmpty}
            />
            <ScopePill
              label={`${universeCfg.label} · por mes de creación`}
              tooltip={
                <>
                  Cuenta las oportunidades{" "}
                  <strong>
                    {universe === "perdidas"
                      ? "perdidas"
                      : "que no se ganaron — perdidas y todavía abiertas"}
                  </strong>{" "}
                  del embudo {scope.label}, apiladas por <strong>{dimLabel}</strong> y
                  agrupadas por el mes en que <strong>se creó el lead</strong> — o sea
                  cuándo nos buscaron, no cuándo se cayeron.
                  {universe === "no-ganadas" && (
                    <>
                      {" "}
                      Los meses recientes se ven altos porque esos leads siguen vivos;
                      cambia a <em>Perdidas</em> para ver solo desenlaces cerrados.
                    </>
                  )}{" "}
                  Las que no tienen {dimLabel} capturado —hoy la mayoría— quedan{" "}
                  <strong>fuera</strong> del apilado y se reportan en la nota bajo la
                  gráfica; el botón <em>{dimOpts.emptyLabel}</em> las trae de vuelta. Con
                  el botón apagado, el total del encabezado y las etiquetas de cada barra
                  cuentan solo las que sí lo traen, que es exactamente lo dibujado.
                </>
              }
            />
          </>
        }
      />
      <ChartCardContent>
        {rows.length === 0 ? (
          // Con el toggle apagado, "no hay barras" tiene DOS causas muy
          // distintas: que no hubo leads, o que ninguno trae el campo. Decir
          // "sin leads" en el segundo caso sería falso — y es el caso probable
          // en un periodo corto, porque el campo casi no se captura.
          <ChartEmpty
            message={
              missingTotal > 0
                ? `Ninguno de los ${n(universeTotal)} ${universeCfg.noun} del periodo trae ${dimField} capturado`
                : "Sin leads no ganados en el periodo seleccionado"
            }
          />
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
                    title={`${entry.label} · ${n(entry.total)}`}
                  >
                    {/* La muestra de color sigue en el gris de SERIES_NEUTRALS
                        aunque la etiqueta vaya en rojizo: ese cuadro tiene que
                        casar con el segmento del stack. */}
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: `var(--color-${slot})` }}
                      aria-hidden
                    />
                    <span className={cn("truncate", entry.kind === "empty" && MISSING_TEXT)}>
                      {labelOf(entry)}
                    </span>
                  </button>
                )
              })}
            </div>

            <ChartContainer id={chartId} config={config} className="h-[280px] w-full">
              {/* El margen superior deja lugar a la etiqueta del total de cada
                  barra; con 5px se recorta sobre la barra más alta. */}
              <BarChart data={rows} margin={{ top: 24, right: 8, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID_STROKE} />
                <XAxis
                  dataKey="label"
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
                  tickFormatter={(v: number) => n(v)}
                  allowDecimals={false}
                />
                <ChartTooltip
                  content={
                    <NonZeroTooltipContent
                      // El formatter reemplaza la fila COMPLETA, así que aquí se
                      // vuelve a dibujar el punto de color y la etiqueta: sin
                      // ellos un tooltip de barra apilada no dice de qué serie
                      // es cada número.
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
                            {n(Number(value))}
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
                    stackId="no-ganados"
                    fill={`var(--color-${slot})`}
                    onClick={(_: unknown, index: number) => openDrill(entry.key, index)}
                    className="cursor-pointer"
                  >
                    {rows.map((_, rowIndex) => {
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
                <Bar dataKey={TOTAL_ANCHOR} stackId="no-ganados" fill="transparent">
                  <LabelList
                    dataKey="total"
                    position="top"
                    offset={8}
                    className="fill-muted-foreground"
                    fontSize={10}
                    formatter={(v: number) => n(v)}
                  />
                </Bar>
              </BarChart>
            </ChartContainer>

            {missingTotal > 0 && (
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                {showEmpty ? (
                  <>
                    El segmento gris son <strong>{n(missingTotal)}</strong> de{" "}
                    {n(universeTotal)} {universeCfg.noun} ({missingPct.toFixed(1)}%) en los
                    que nadie capturó <strong>{dimField}</strong> en el CRM.
                  </>
                ) : (
                  <>
                    La gráfica muestra los <strong>{n(data.grandTotal)}</strong>{" "}
                    {universeCfg.noun} que sí traen <strong>{dimField}</strong> capturado.
                    Los otros {n(missingTotal)} de {n(universeTotal)} (
                    {missingPct.toFixed(1)}%) quedan fuera — préndelos con{" "}
                    <em>{dimOpts.emptyLabel}</em> arriba si quieres verlos, aunque tapan
                    todo lo demás.
                  </>
                )}{" "}
                Ese campo se llena al <strong>perfilar</strong> el lead, y estos se cayeron
                antes de llegar ahí: no es un producto sin nombre, es el hueco de captura.
              </p>
            )}
            {noDateTotal > 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                La última barra agrupa {n(noDateTotal)} {universeCfg.noun} sin fecha de
                creación legible.
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
