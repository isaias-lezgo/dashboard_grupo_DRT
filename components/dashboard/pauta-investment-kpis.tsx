"use client"

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import type { PautaInvestment, PautaMetrics } from "@/lib/meta-attribution"

export type PautaDrillKey = keyof PautaMetrics["oppIds"]

/** Formateadores compartidos por la fila KPI y la tabla. */
export function makeFormatters(currency: string) {
  const money = currency
    ? new Intl.NumberFormat("es-MX", { style: "currency", currency, maximumFractionDigits: 2 })
    : null
  return {
    n: (v: number) => v.toLocaleString("es-MX"),
    money: (v: number | null) =>
      v === null ? "—" : money ? money.format(v) : v.toLocaleString("es-MX", { maximumFractionDigits: 2 }),
    pct: (v: number | null, digits = 1) =>
      v === null ? "—" : `${(v * 100).toLocaleString("es-MX", { maximumFractionDigits: digits })}%`,
  }
}

function Tile({
  label,
  value,
  sub,
  highlight,
  onClick,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  highlight?: boolean
  onClick?: () => void
}) {
  const className = cn(
    "flex min-w-0 flex-col gap-1 rounded-lg border px-3 py-2.5 text-left",
    highlight ? "border-primary/40 bg-primary/5" : "border-border bg-muted/20",
    onClick && "cursor-pointer transition-colors hover:bg-muted/50"
  )
  const body = (
    <>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("truncate text-lg font-semibold tabular-nums leading-tight", highlight && "text-primary")}>
        {value}
      </span>
      {sub !== undefined && <span className="text-[11px] leading-snug text-muted-foreground">{sub}</span>}
    </>
  )
  return onClick ? (
    <button type="button" onClick={onClick} className={className}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  )
}

export function PautaInvestmentKpis({
  inv,
  onDrill,
}: {
  inv: PautaInvestment
  onDrill: (key: PautaDrillKey, title: string) => void
}) {
  const f = makeFormatters(inv.currency)
  const k = inv.kpi
  const share = (v: number) => (k.leadsCrm > 0 ? f.pct(v / k.leadsCrm, 1) : null)
  const diff = k.leadsMeta - k.leadsCrm
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
        <Tile label="Gasto" value={f.money(k.spend)} sub={inv.mixedCurrency ? "monedas mixtas" : undefined} />
        <Tile
          label="Leads CRM"
          value={f.n(k.leadsCrm)}
          sub={
            k.leadsMeta > 0
              ? `Meta reportó ${f.n(k.leadsMeta)}${diff > 0 ? ` · ${f.n(diff)} no llegaron` : ""}`
              : undefined
          }
          onClick={k.leadsCrm > 0 ? () => onDrill("leads", "Leads CRM atribuidos a pauta") : undefined}
        />
        <Tile label="CPL" value={f.money(k.cpl)} sub="por lead del CRM" highlight />
        <Tile
          label="Citas"
          value={f.n(k.citas)}
          sub={share(k.citas) ? `${share(k.citas)} de los leads` : undefined}
          onClick={k.citas > 0 ? () => onDrill("citas", "Citas de leads de pauta") : undefined}
        />
        <Tile
          label="Visitas"
          value={f.n(k.visitas)}
          sub={share(k.visitas) ? `${share(k.visitas)} de los leads` : undefined}
          onClick={k.visitas > 0 ? () => onDrill("visitas", "Visitas de leads de pauta") : undefined}
        />
        <Tile
          label="Ventas"
          value={f.n(k.ventas)}
          sub={share(k.ventas) ? `${share(k.ventas)} de los leads` : undefined}
          onClick={k.ventas > 0 ? () => onDrill("ventas", "Ventas de leads de pauta") : undefined}
        />
        <Tile label="Costo por venta" value={f.money(k.costPerVenta)} sub="gasto ÷ ventas" />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Impresiones {f.n(k.impressions)} · Clics {f.n(k.clicks)} · CPM {f.money(k.cpm)} · CTR {f.pct(k.ctr, 2)}
      </p>
    </div>
  )
}
