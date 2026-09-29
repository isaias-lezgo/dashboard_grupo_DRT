"use client"

import { useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { ChevronDown, ChevronRight, Copy, ExternalLink, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PautaAdRow, PautaCampaignRow, PautaInvestment, PautaMetrics } from "@/lib/meta-attribution"
import { MISSING_TEXT } from "./dashboard-ui"
import { makeFormatters, type PautaDrillKey } from "./pauta-investment-kpis"

/** Campañas visibles con la tabla colapsada, por gasto. */
const TOP_ROWS = 15

type Column = {
  key: keyof PautaMetrics
  label: string
  kind: "money" | "int" | "pct"
  drill?: PautaDrillKey
  muted?: boolean
}

const COLUMNS: Column[] = [
  { key: "spend", label: "Gasto", kind: "money" },
  { key: "impressions", label: "Impr.", kind: "int", muted: true },
  { key: "clicks", label: "Clics", kind: "int", muted: true },
  { key: "cpm", label: "CPM", kind: "money", muted: true },
  { key: "ctr", label: "CTR", kind: "pct", muted: true },
  { key: "leadsMeta", label: "Leads Meta", kind: "int", muted: true },
  { key: "leadsCrm", label: "Leads CRM", kind: "int", drill: "leads" },
  { key: "citas", label: "Citas", kind: "int", drill: "citas" },
  { key: "visitas", label: "Visitas", kind: "int", drill: "visitas" },
  { key: "ventas", label: "Ventas", kind: "int", drill: "ventas" },
  { key: "cpl", label: "CPL", kind: "money" },
]

type CellFn = (m: PautaMetrics, col: Column, title: string, style?: CSSProperties) => ReactNode

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
}

function hostOf(u: string): string {
  try {
    const url = new URL(u)
    return `${url.host.replace(/^www\./, "")}${url.pathname}`.replace(/\/$/, "")
  } catch {
    return u
  }
}

function CopyId({ id }: { id: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      title="Copiar id"
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard?.writeText(id).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
      className="ml-1 inline-flex text-muted-foreground hover:text-foreground"
    >
      <Copy className={cn("h-3 w-3", done && "text-primary")} aria-hidden />
    </button>
  )
}

function UrlCell({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null
  const [first, ...rest] = urls
  return (
    <span
      className="inline-flex max-w-[16rem] items-center gap-1 font-mono text-[10px] text-muted-foreground"
      title={urls.join("\n")}
    >
      <span className="truncate">{hostOf(first)}</span>
      {rest.length > 0 && <span className="shrink-0">+{rest.length}</span>}
      <a
        href={first}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="shrink-0 hover:text-foreground"
        title="Abrir"
      >
        <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </span>
  )
}

export function PautaInvestmentTable({
  inv,
  onDrill,
}: {
  inv: PautaInvestment
  onDrill: (key: PautaDrillKey, title: string, m: PautaMetrics) => void
}) {
  const f = makeFormatters(inv.currency)
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState(false)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [allOpen, setAllOpen] = useState(false)

  const filtered = useMemo(() => {
    const q = fold(query.trim())
    return q
      ? inv.campaigns.filter((c) => fold(c.name).includes(q) || fold(c.accountName).includes(q))
      : inv.campaigns
  }, [inv.campaigns, query])
  const visible = expanded || query ? filtered : filtered.slice(0, TOP_ROWS)
  const hidden = filtered.length - visible.length
  const maxSpend = Math.max(0, ...inv.campaigns.map((c) => c.metrics.spend))

  const isOpen = (id: string) => allOpen || open.has(id)
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const cell: CellFn = (m, col, title, style) => {
    const v = m[col.key] as number | null
    const text = col.kind === "money" ? f.money(v) : col.kind === "pct" ? f.pct(v, 2) : f.n(v ?? 0)
    const count = col.drill ? m.oppIds[col.drill].length : 0
    const clickable = !!col.drill && count > 0
    const missingCost = col.key === "cpl" && m.spend > 0 && m.leadsCrm === 0
    return (
      <td
        key={col.key}
        style={style}
        onClick={clickable ? () => onDrill(col.drill!, title, m) : undefined}
        className={cn(
          "border-b border-border px-3 py-1.5",
          col.muted && "text-muted-foreground",
          clickable && "cursor-pointer hover:bg-muted/50",
          missingCost && cn("italic", MISSING_TEXT)
        )}
        title={missingCost ? "Gasto sin un solo lead en el CRM" : undefined}
      >
        {col.kind === "int" && v === 0 ? <span className="text-muted-foreground">–</span> : text}
      </td>
    )
  }

  const spendShade = (spend: number): CSSProperties | undefined =>
    maxSpend > 0
      ? {
          backgroundColor: `color-mix(in oklab, var(--primary) ${Math.round((spend / maxSpend) * 22)}%, transparent)`,
        }
      : undefined

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar campaña…"
            className="h-8 w-56 rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus:border-primary/50"
          />
        </label>
        <button
          type="button"
          onClick={() => setAllOpen((v) => !v)}
          aria-pressed={allOpen}
          className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          {allOpen ? "Contraer anuncios" : "Expandir anuncios"}
        </button>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {filtered.length === inv.campaigns.length
            ? `${f.n(inv.campaigns.length)} campañas`
            : `${f.n(filtered.length)} de ${f.n(inv.campaigns.length)} campañas`}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-max min-w-full border-separate border-spacing-0 text-right text-xs tabular-nums">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 min-w-[18rem] border-b border-r border-border bg-card px-3 py-2 text-left font-semibold">
                Campaña / anuncio
              </th>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    "min-w-[5.5rem] border-b border-border px-3 py-2",
                    c.muted ? "font-medium text-muted-foreground" : "font-semibold"
                  )}
                >
                  {c.label}
                  {c.key === "spend" ? " ↓" : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <CampaignRows
                key={c.campaignId || "__sin"}
                c={c}
                open={isOpen(c.campaignId)}
                onToggle={() => toggle(c.campaignId)}
                cell={cell}
                shade={spendShade}
              />
            ))}
          </tbody>
        </table>
      </div>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full rounded-md px-2 py-1.5 text-center text-[11px] font-medium text-primary transition-colors hover:bg-muted/50"
        >
          Ver {f.n(hidden)} campañas más →
        </button>
      )}
      {expanded && !query && inv.campaigns.length > TOP_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full rounded-md px-2 py-1.5 text-center text-[11px] font-medium text-primary hover:bg-muted/50"
        >
          Ver menos
        </button>
      )}
    </div>
  )
}

function CampaignRows({
  c,
  open,
  onToggle,
  cell,
  shade,
}: {
  c: PautaCampaignRow
  open: boolean
  onToggle: () => void
  cell: CellFn
  shade: (spend: number) => CSSProperties | undefined
}) {
  const Chevron = open ? ChevronDown : ChevronRight
  const hasChildren = c.ads.length > 0 || c.campaignOnlyLeads > 0
  return (
    <>
      <tr className="font-medium">
        <th
          scope="row"
          onClick={hasChildren ? onToggle : undefined}
          className={cn(
            "sticky left-0 z-10 max-w-[26rem] border-b border-r border-border bg-card px-3 py-2 text-left",
            hasChildren && "cursor-pointer select-none hover:bg-muted/50"
          )}
          title={c.accountName ? `${c.name} · ${c.accountName}` : c.name}
        >
          <span className="inline-flex max-w-full items-center gap-1.5">
            {hasChildren ? (
              <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <span className="w-3.5" />
            )}
            <span className={cn("truncate", c.missing && cn("italic", MISSING_TEXT))}>{c.name}</span>
          </span>
        </th>
        {/* La columna Gasto lleva sombreado normalizado por columna, como en advisor-stage-table. */}
        {COLUMNS.map((col) =>
          cell(c.metrics, col, c.name, col.key === "spend" ? shade(c.metrics.spend) : undefined)
        )}
      </tr>
      {open &&
        c.ads.map((a: PautaAdRow) => (
          <tr key={a.adId} className="text-muted-foreground">
            <td className="sticky left-0 z-10 border-b border-r border-border bg-card py-1.5 pl-8 pr-3 text-left">
              <span className="inline-flex max-w-full items-center gap-2">
                <span className={cn("font-mono text-[11px]", a.deleted && cn("italic", MISSING_TEXT))}>
                  {a.deleted ? a.name : a.adId}
                </span>
                {!a.deleted && <CopyId id={a.adId} />}
                {a.deleted && <span className="font-mono text-[10px]">{a.adId}</span>}
                {!a.deleted && a.name && (
                  <span className="truncate text-[11px]" title={a.name}>
                    {a.name}
                  </span>
                )}
                <UrlCell urls={a.urls} />
              </span>
            </td>
            {COLUMNS.map((col) => cell(a.metrics, col, `${c.name} · ${a.deleted ? a.name : a.adId}`))}
          </tr>
        ))}
      {open && c.campaignOnlyLeads > 0 && (
        <tr className="text-muted-foreground">
          <td className="sticky left-0 z-10 border-b border-r border-border bg-card py-1.5 pl-8 pr-3 text-left italic">
            Sin anuncio identificado · {c.campaignOnlyLeads.toLocaleString("es-MX")}{" "}
            {c.campaignOnlyLeads === 1 ? "lead" : "leads"}
          </td>
          {COLUMNS.map((col) => (
            <td key={col.key} className="border-b border-border px-3 py-1.5">
              <span className="text-muted-foreground">–</span>
            </td>
          ))}
        </tr>
      )}
    </>
  )
}
