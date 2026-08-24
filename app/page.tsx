"use client"

import { useState, useEffect, useMemo } from "react"
import Image from "next/image"
import { useTheme } from "next-themes"
import { AnimatePresence } from "framer-motion"
import { PanelDashboard } from "@/components/dashboard/panel-dashboard"
import { DateRangeFilter } from "@/components/dashboard/date-range-filter"
import { filterByDateRange, resolveDateRange, type DateFilter } from "@/lib/date-range"
import {
  ActiveFiltersPill,
  MultiSelectFilter,
  type MultiSelectOption,
} from "@/components/dashboard/multi-select-filter"
import {
  buildCategoryOptions,
  withPinnedSelection,
  type CategoryOption,
} from "@/lib/category-filter"
import { NO_VALUE_KEY, NO_VALUE_LABEL } from "@/lib/opportunity-breakdown"
import {
  collectDesarrollos,
  desarrolloOf,
  DESARROLLO_PANELS,
  NO_DESARROLLO,
  PANEL_SCOPES,
  scopeOpportunities,
  type PanelId,
} from "@/lib/panel-scope"
import {
  activeFilterCount,
  advisorKeyOf,
  applyPanelFilters,
  collectAdvisors,
  EMPTY_PANEL_FILTERS,
  NO_ASESOR,
  type PanelFilters,
} from "@/lib/panel-filters"
import { format } from "date-fns"
import { es } from "date-fns/locale"
import { ConversationsChat } from "@/components/dashboard/conversations-chat"
import { LoadingScreen } from "@/components/dashboard/loading-screen"
import { SyncWarningBanner } from "@/components/dashboard/sync-warning-banner"
import { useDashboardData } from "@/hooks/use-dashboard-data"
import { useConversationsData } from "@/hooks/use-conversations-data"
import { useConversationActivity } from "@/hooks/use-conversation-activity"
import {
  Building2,
  LayoutGrid,
  MapPin,
  Megaphone,
  MessageSquare,
  UserRound,
  RefreshCw,
  Loader2,
  AlertCircle,
  Sun,
  Moon,
  Users,
  Target,
  ClipboardList,
  Sparkles,
  LogOut,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

// GENERAL, un panel por desarrollo, y el asistente de IA.
type DashboardTab = PanelId | "conversations"

/** Las pestañas, en orden. GENERAL primero: es la vista de grupo. */
const PANEL_TABS = ["general", ...DESARROLLO_PANELS] as const satisfies readonly PanelId[]

// Browser-tab title per view. The app is a single route, so the title is set
// imperatively — `metadata` in layout.tsx can only give one static fallback.
function tabTitle(tab: DashboardTab): string {
  if (tab === "conversations") return "Asistente IA - Lezgo Suite CRM"
  const { label } = PANEL_SCOPES[tab]
  return `${tab === "general" ? "General" : label} - Lezgo Suite CRM`
}

/**
 * De opción de categoría a fila del menú. El aviso de variante es lo único que
 * se compone aquí: el módulo cuenta las grafías, la UI decide cómo se lee.
 */
function toMenuOptions(
  options: CategoryOption[],
  selected: string[]
): MultiSelectOption[] {
  return withPinnedSelection(options, selected).map((o) => ({
    value: o.value,
    label: o.label,
    count: o.count,
    muted: o.muted,
    variantHint:
      o.variantCount > 1
        ? `${o.variantCount} grafías distintas de este valor — probable error de captura en el CRM`
        : undefined,
  }))
}

/**
 * Antigüedad en tiempo relativo. El panel se sirve de un caché en Postgres, así
 * que lo que está en pantalla puede tener minutos u horas: una hora de reloj
 * ("Actualizado 09:14") no dice si eso es de hoy temprano o de anteayer, y un
 * caché sin antigüedad visible miente por omisión.
 *
 * `_tick` no se usa dentro: existe solo para que React vuelva a llamar a esta
 * función cada minuto (ver el intervalo en el componente).
 */
function relativeAge(fetchedAt: string, _tick: number): string {
  const mins = Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 60000)
  if (mins < 1) return "hace un momento"
  if (mins === 1) return "hace 1 minuto"
  if (mins < 60) return `hace ${mins} minutos`
  const hrs = Math.floor(mins / 60)
  if (hrs === 1) return "hace 1 hora"
  if (hrs < 24) return `hace ${hrs} horas`
  const days = Math.floor(hrs / 24)
  return days === 1 ? "hace 1 día" : `hace ${days} días`
}

export default function DashboardPage() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [activeTab, setActiveTab] = useState<DashboardTab>("general")
  // El texto "Actualizado hace X" es relativo, así que tiene que re-renderizarse
  // solo; nada más en la página cambia para obligarlo.
  const [nowTick, setNowTick] = useState(0)

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => { document.title = tabTitle(activeTab) }, [activeTab])

  const {
    data,
    isLoading,
    isError,
    progress,
    locationName,
    steps,
    elapsedMs,
    stalled,
    liveSync,
    refresh,
  } = useDashboardData({})
  const { messages } = useConversationsData()
  // Actividad de conversaciones para la matriz de abandono. Va aparte del sync
  // principal (es un recorrido de miles de conversaciones) y su ESTADO viaja
  // con ella: con el mapa vacío la matriz acusaría abandono total.
  const {
    activity: conversationActivity,
    status: activityStatus,
    refresh: refreshActivity,
  } = useConversationActivity()

  const [dateFilter, setDateFilter] = useState<DateFilter>({ preset: "all" })
  const dateRange = useMemo(() => resolveDateRange(dateFilter), [dateFilter])

  // Los cuatro filtros de alcance de la barra. Se aplican aquí, sobre el set
  // crudo y ANTES del corte por fecha, para que las slices filtradas y los sets
  // `all*` que resuelven los drill-downs vean el mismo universo: un drawer nunca
  // puede sacar a la luz un registro que los gráficos excluyeron. El asistente
  // de IA queda fuera a propósito, igual que del filtro de fechas.
  const baseOpportunities = data?.opportunities ?? []
  // Origen y canal viven en el CONTACTO en esta cuenta — ver categoryValuesOf.
  // Se arma sobre el set SIN filtrar por fecha, por la misma razón que los
  // drill-downs resuelven contra los sets `all*`.
  const contactById = useMemo(
    () => new Map((data?.contacts ?? []).map((c) => [c.id, c])),
    [data?.contacts]
  )
  const [panelFilters, setPanelFilters] = useState<PanelFilters>(EMPTY_PANEL_FILTERS)
  const scopedOpportunities = useMemo(
    () => applyPanelFilters(baseOpportunities, panelFilters, data?.pipelines, contactById),
    [baseOpportunities, panelFilters, data?.pipelines, contactById]
  )

  // Las opciones y sus conteos se calculan SIN los filtros de panel puestos: si
  // se calcularan sobre el set ya filtrado, elegir una sucursal dejaría el menú
  // con una sola opción y sin manera de agregar otra.
  const desarrolloOptions = useMemo(() => {
    const pipelines = data?.pipelines
    const counts = new Map<string, number>()
    for (const o of baseOpportunities) {
      const d = desarrolloOf(o, pipelines)
      counts.set(d, (counts.get(d) ?? 0) + 1)
    }
    const named = collectDesarrollos(baseOpportunities, pipelines).map((value) => ({
      value,
      label: value,
      count: counts.get(value) ?? 0,
    }))
    const sinDesarrollo = counts.get(NO_DESARROLLO) ?? 0
    // La cubeta vacía siempre al final y en gris: no es un desarrollo, pero deja
    // esos registros alcanzables desde la barra.
    return sinDesarrollo > 0
      ? [...named, { value: NO_DESARROLLO, label: NO_DESARROLLO, count: sinDesarrollo, muted: true }]
      : named
  }, [baseOpportunities, data?.pipelines])

  // Los asesores salen de los DATOS, no de una lista escrita a mano: la
  // subcuenta tiene ~24 asesores activos y una lista fija se desactualiza en
  // silencio la primera vez que entra alguien nuevo al equipo.
  const asesorOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const o of baseOpportunities) {
      const key = advisorKeyOf(o)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const named = collectAdvisors(baseOpportunities).map((a) => ({
      value: a.key,
      label: a.label,
      count: counts.get(a.key) ?? 0,
    }))
    const sinAsesor = counts.get(NO_ASESOR) ?? 0
    return sinAsesor > 0
      ? [...named, { value: NO_ASESOR, label: NO_ASESOR, count: sinAsesor, muted: true }]
      : named
  }, [baseOpportunities])

  // Las opciones de origen y canal se acotan al pipeline de la pestaña activa y
  // al rango de fechas —así los conteos hablan de lo que el panel está
  // mostrando— pero NO a los filtros de panel: si se calcularan sobre el set ya
  // filtrado, marcar "Meta" borraría del menú todo lo demás.
  //
  // Es una regla distinta de la de sucursal y asesor, que se calculan sobre el
  // set completo. Está documentado en el spec como divergencia conocida.
  const categoryBase = useMemo(() => {
    if (activeTab === "conversations") return []
    const scoped = scopeOpportunities(baseOpportunities, activeTab, data?.pipelines ?? [])
    return filterByDateRange(scoped, (o) => o.createdAt, dateRange)
  }, [baseOpportunities, activeTab, data?.pipelines, dateRange])

  const origenOptions = useMemo(
    () => toMenuOptions(buildCategoryOptions(categoryBase, "origen", contactById), panelFilters.origen),
    [categoryBase, panelFilters.origen, contactById]
  )
  const canalOptions = useMemo(
    () => toMenuOptions(buildCategoryOptions(categoryBase, "canal", contactById), panelFilters.canal),
    [categoryBase, panelFilters.canal, contactById]
  )

  // Human label of the active date filter, for the PDF report cover.
  const periodLabel = useMemo(() => {
    const base = (() => {
      switch (dateFilter.preset) {
        case "week": return "Últimos 7 días"
        case "month": return "Últimos 30 días"
        case "3m": return "Últimos 3 meses"
        case "6m": return "Últimos 6 meses"
        case "custom":
          if (!dateRange) return "Todo el historial"
          return `${format(dateRange.from, "d MMM yyyy", { locale: es })} – ${format(dateRange.to, "d MMM yyyy", { locale: es })}`
        default: return "Todo el historial"
      }
    })()

    // El alcance del reporte incluye los filtros de la barra, no solo la fecha:
    // una portada que calla que el panel está recortado es una portada que miente.
    const list = (values: string[]) =>
      values.map((v) => (v === NO_VALUE_KEY ? NO_VALUE_LABEL : v)).join(", ")
    const parts = [base]
    if (panelFilters.desarrollos.length)
      parts.push(`Desarrollo: ${list(panelFilters.desarrollos)}`)
    if (panelFilters.asesores.length) {
      // Las claves son nombres normalizados; la etiqueta legible vive en las
      // opciones del menú, que ya se derivaron de los datos.
      const names = panelFilters.asesores.map(
        (k) => asesorOptions.find((a) => a.value === k)?.label ?? k
      )
      parts.push(`Asesor: ${names.join(", ")}`)
    }
    if (panelFilters.origen.length) parts.push(`Origen: ${list(panelFilters.origen)}`)
    if (panelFilters.canal.length) parts.push(`Canal: ${list(panelFilters.canal)}`)
    return parts.join(" · ")
  }, [dateFilter.preset, dateRange, panelFilters, asesorOptions])

  const contacts = useMemo(
    () => filterByDateRange(data?.contacts ?? [], (c) => c.createdAt, dateRange),
    [data?.contacts, dateRange]
  )
  const opportunities = useMemo(
    () => filterByDateRange(scopedOpportunities, (o) => o.createdAt, dateRange),
    [scopedOpportunities, dateRange]
  )
  const calls = useMemo(
    () => filterByDateRange(data?.calls ?? [], (c) => c.createdAt, dateRange),
    [data?.calls, dateRange]
  )
  const appointments = useMemo(
    () => filterByDateRange(data?.appointments ?? [], (a) => a.startTime, dateRange),
    [data?.appointments, dateRange]
  )
  const tasks = useMemo(
    () => filterByDateRange(data?.tasks ?? [], (t) => t.createdAt ?? t.dueDate, dateRange),
    [data?.tasks, dateRange]
  )
  const pautas = useMemo(
    () => filterByDateRange(data?.pautas ?? [], (p) => p.createdAt, dateRange),
    [data?.pautas, dateRange]
  )
  const filteredMessages = useMemo(
    () => filterByDateRange(messages, (m) => m.createdAt, dateRange),
    [messages, dateRange]
  )
  const availableMembers = data?.members ?? []
  const availableTags = data?.tags ?? []

  const isInitialLoad = isLoading && !data

  return (
    <>
    <AnimatePresence>
      {isInitialLoad && (
        <LoadingScreen
          key="loader"
          progress={progress}
          locationName={locationName}
          steps={steps}
          elapsedMs={elapsedMs}
          stalled={stalled}
          liveSync={liveSync}
        />
      )}
    </AnimatePresence>
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header */}
      <header className="border-b border-[#335577]/20 bg-[#0D172F] px-4 py-3 text-white shadow-none sm:px-6 sm:py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-3">
            <Image
              src="/logo-mark.png"
              alt="Lezgo Suite"
              width={2851}
              height={3371}
              priority
              className="h-9 w-auto shrink-0"
            />
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold leading-tight tracking-tight">Lezgo Suite Analíticas</h1>
            </div>
            {locationName && (
              <>
                <span aria-hidden className="hidden h-6 w-px shrink-0 bg-white/15 sm:block" />
                <span className="hidden min-w-0 max-w-[220px] truncate text-[13px] font-medium text-white/80 sm:inline-block">
                  {locationName}
                </span>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
            {isError && (
              <div className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5" />
                Error al cargar datos
              </div>
            )}
            {!isLoading && data && (
              <TooltipProvider delayDuration={200}>
                <div className="flex items-center gap-1.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex cursor-default items-center gap-1 rounded-md border border-white/15 bg-white/[0.07] px-2 py-1 text-[11px] font-medium tabular-nums text-white">
                        <Users className="h-3 w-3 text-white/45" />
                        {data.contacts.length.toLocaleString("es-MX")}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Contactos cargados</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex cursor-default items-center gap-1 rounded-md border border-white/15 bg-white/[0.07] px-2 py-1 text-[11px] font-medium tabular-nums text-white">
                        <Target className="h-3 w-3 text-white/45" />
                        {data.opportunities.length.toLocaleString("es-MX")}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Oportunidades cargadas</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex cursor-default items-center gap-1 rounded-md border border-white/15 bg-white/[0.07] px-2 py-1 text-[11px] font-medium tabular-nums text-white">
                        <ClipboardList className="h-3 w-3 text-white/45" />
                        {(data?.pautas ?? []).length.toLocaleString("es-MX")}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Pautas cargadas</TooltipContent>
                  </Tooltip>
                </div>
              </TooltipProvider>
            )}
            <span className="hidden text-[11px] tabular-nums text-white/55 sm:inline">
              {isLoading
                ? (progress || "Sincronizando…")
                : data?.meta?.fetchedAt
                  ? `Actualizado ${relativeAge(data.meta.fetchedAt, nowTick)}`
                  : ""}
            </span>
            
           
            <Button
              variant="default"
              size="sm"
              className="h-8 gap-1.5 rounded-lg text-xs font-medium"
              onClick={() => refresh()}
              disabled={isLoading}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Actualizar</span>
            </Button>
            
            {isLoading && <Loader2 className="h-4 w-4 animate-spin text-white/80" />}

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              aria-label="Cambiar tema"
            >
              {mounted && resolvedTheme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" })
                // A full page load, not a router push: this drops all client-side
                // dashboard state, so the next client to log in on this browser
                // can't see the previous client's data behind a cached React tree.
                window.location.href = "/login"
              }}
              aria-label="Cerrar sesión"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      {data?.warnings && data.warnings.length > 0 && (
        <SyncWarningBanner
          warnings={data.warnings}
          onRetry={() => refresh()}
          isLoading={isLoading}
        />
      )}

      <nav className="border-b border-border bg-card px-4 sm:px-6" aria-label="Vistas del panel">
        {/* Ocho pestañas no caben en un teléfono: la fila se desplaza en vez de
            apretarse hasta romper las etiquetas. */}
        <div className="flex gap-5 overflow-x-auto sm:gap-8">
          {[
            ...PANEL_TABS.map((id) => ({
              id: id as DashboardTab,
              label: id === "general" ? "GENERAL" : PANEL_SCOPES[id].label,
              icon: id === "general" ? LayoutGrid : Building2,
              mark: null as string | null,
            })),
            {
              id: "conversations" as DashboardTab,
              label: "Asistente IA",
              icon: Sparkles,
              mark: null as string | null,
            },
          ].map(({ id, label, icon: Icon, mark }) => {
            const active = activeTab === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={cn(
                  "relative flex items-center gap-2 py-3 text-sm font-medium transition-colors duration-200",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {mark ? (
                  <Image
                    src={mark}
                    alt=""
                    width={60}
                    height={60}
                    aria-hidden
                    className={cn(
                      "h-4 w-4 shrink-0 object-contain transition-opacity duration-200",
                      active ? "opacity-100" : "opacity-60",
                    )}
                  />
                ) : (
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                )}
                {label}
                {active && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary" />
                )}
              </button>
            )
          })}
        </div>
      </nav>

      {activeTab !== "conversations" && (
        <DateRangeFilter
          value={dateFilter}
          onChange={setDateFilter}
          filters={
            <>
              <MultiSelectFilter
                label="Desarrollo"
                icon={MapPin}
                options={desarrolloOptions}
                selected={panelFilters.desarrollos}
                onChange={(desarrollos) => setPanelFilters((f) => ({ ...f, desarrollos }))}
                emptyMessage="Ninguna oportunidad resuelve su desarrollo"
              />
              <MultiSelectFilter
                label="Asesor"
                icon={UserRound}
                options={asesorOptions}
                selected={panelFilters.asesores}
                onChange={(asesores) => setPanelFilters((f) => ({ ...f, asesores }))}
                emptyMessage="Ninguna oportunidad tiene asesor asignado"
                searchable
              />
              <MultiSelectFilter
                label="Origen de lead"
                icon={Megaphone}
                options={origenOptions}
                selected={panelFilters.origen}
                onChange={(origen) => setPanelFilters((f) => ({ ...f, origen }))}
                emptyMessage="Sin valores en este periodo"
                searchable
              />
              <MultiSelectFilter
                label="Canal de contacto"
                icon={MessageSquare}
                options={canalOptions}
                selected={panelFilters.canal}
                onChange={(canal) => setPanelFilters((f) => ({ ...f, canal }))}
                emptyMessage="Sin valores en este periodo"
                searchable
              />
              <ActiveFiltersPill
                count={activeFilterCount(panelFilters)}
                onClear={() => setPanelFilters(EMPTY_PANEL_FILTERS)}
              />
            </>
          }
        />
      )}

      {/* Dashboard Content */}
      <div className="flex-1 pt-2 pb-6">
        {/* Un solo panel para los siete alcances: `panel` decide el embudo y
            lib/panel-scope.ts decide qué significa. La superficie de props es la
            misma para todos — las slices cortadas por fecha para los gráficos,
            más los sets `all*` sin filtrar como tablas de lookup de los joins de
            drill-down. */}
        {activeTab !== "conversations" && (
          <PanelDashboard
            key={activeTab}
            panel={activeTab}
            opportunities={opportunities}
            allOpportunities={scopedOpportunities}
            contacts={contacts}
            allContacts={data?.contacts ?? []}
            pautas={pautas}
            allPautas={data?.pautas ?? []}
            pipelines={data?.pipelines ?? []}
            tasks={tasks}
            allTasks={data?.tasks ?? []}
            unfilteredOpportunities={data?.opportunities ?? []}
            conversationActivity={conversationActivity}
            activityStatus={activityStatus}
            onRetryActivity={refreshActivity}
            calls={calls}
            messages={filteredMessages}
            allMessages={messages}
            appointments={appointments}
            allAppointments={data?.appointments ?? []}
            members={availableMembers}
            locationId={data?.locationId ?? ""}
            locationName={locationName ?? undefined}
            periodLabel={periodLabel}
            dateRange={dateRange}
          />
        )}
        {/* Kept permanently mounted (hidden when inactive) so the AI chat
            history survives switching to the panel tabs. */}
        {/* The AI assistant always sees the full (unfiltered) dataset — the
            date filter bar is hidden on this tab. */}
        <div className={cn(activeTab !== "conversations" && "hidden")}>
          <ConversationsChat
            dataset={{
              contacts: data?.contacts ?? [],
              opportunities: data?.opportunities ?? [],
              pautas: data?.pautas ?? [],
              appointments: data?.appointments ?? [],
              messages,
              tasks: data?.tasks ?? [],
              calls: data?.calls ?? [],
            }}
            locationId={data?.locationId}
          />
        </div>
      </div>
    </div>
    </>
  )
}
