"use client"

import { useMemo, useState } from "react"
import { Coins } from "lucide-react"
import type {
  Appointment,
  Call,
  Contact,
  Message,
  Opportunity,
  Pauta,
  Pipeline,
  SyncWarning,
  Task,
} from "@/lib/types"
import type { ResolvedDateRange } from "@/lib/date-range"
import {
  agenciaOfAd,
  buildPautaInvestment,
  campaignNameOfAd,
  localDay,
  scopeMetaDaily,
  type MetaPanelContext,
  type PautaMetrics,
} from "@/lib/meta-attribution"
import { NO_AGENCIA } from "@/lib/agencia"
import type { PanelFilters } from "@/lib/panel-filters"
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
import { PautaInvestmentKpis, type PautaDrillKey } from "./pauta-investment-kpis"
import { PautaInvestmentTable } from "./pauta-investment-table"

const n = (v: number) => v.toLocaleString("es-MX")

export interface PautaInvestmentCardProps {
  panel: PanelId
  /** Ya filtradas por fecha y por los menús del panel: la cohorte. */
  opportunities: Opportunity[]
  allOpportunities: Opportunity[]
  contacts: Contact[]
  allContacts: Contact[]
  pipelines?: Pipeline[]
  tasks?: Task[]
  calls?: Call[]
  allPautas?: Pauta[]
  appointments?: Appointment[]
  /** SIN filtrar: la cita cuenta en cualquier fecha, como en el embudo de GENERAL. */
  allAppointments?: Appointment[]
  messages?: Message[]
  locationId?: string
  dateRange?: ResolvedDateRange | null
  metaPanel?: MetaPanelContext | null
  metaWarning?: SyncWarning | null
  locationCreatedAt?: string
  /**
   * Los filtros de la barra. Campaña y Agencia acotan también el GASTO (por el
   * nombre de la campaña de Meta y por la agencia de su nomenclatura); los
   * demás filtran solo leads, porque el gasto no sabe de asesores ni de canal.
   */
  panelFilters?: PanelFilters
}

/**
 * "Inversión y rendimiento de pauta": el gasto de Meta cruzado con los leads
 * del CRM por campaña → anuncio, con los nombres de Meta. Reemplaza a
 * "Rendimiento por pauta" (2026-09-28). Todo el cálculo vive en
 * buildPautaInvestment; aquí solo se acota y se dibuja.
 */
export function PautaInvestmentCard({
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
  dateRange = null,
  metaPanel = null,
  metaWarning = null,
  locationCreatedAt,
  panelFilters,
}: PautaInvestmentCardProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  // El nombre real del pipeline de la pestaña (null en GENERAL) y las cuentas
  // publicitarias que le corresponden.
  const desarrollo = useMemo(() => {
    const id = resolvePipelineId(pipelines, panel)
    if (id === null) return null
    return pipelines.find((p) => p.id === id)?.name?.trim() || scope.label
  }, [pipelines, panel, scope.label])

  const accountIds = useMemo(() => {
    if (!metaPanel || desarrollo === null) return null
    return new Set(
      [...metaPanel.accountToPipeline.entries()].filter(([, d]) => d === desarrollo).map(([id]) => id)
    )
  }, [metaPanel, desarrollo])

  const contactsWithCita = useMemo(() => {
    const s = new Set<string>()
    for (const a of allAppointments.length > 0 ? allAppointments : appointments) if (a.contactId) s.add(a.contactId)
    return s
  }, [allAppointments, appointments])

  const range = useMemo(
    () =>
      dateRange
        ? { start: localDay(dateRange.from.toISOString()), end: localDay(dateRange.to.toISOString()) }
        : null,
    [dateRange]
  )

  // El gasto obedece a los filtros Campaña y Agencia: sin esto, filtrar por
  // agencia dejaba los leads de una y el gasto de todas, y el CPL mentía. Un
  // anuncio pasa si el nombre de su campaña de Meta está entre las campañas
  // marcadas y si su agencia (nomenclatura V1 en campaña → adset → anuncio)
  // está entre las marcadas; "Sin agencia" alcanza a los anuncios sin código.
  const spendFilter = useMemo(() => {
    const campanas = panelFilters?.campanas ?? []
    const agencias = panelFilters?.agencias ?? []
    if (!metaPanel || (campanas.length === 0 && agencias.length === 0)) return null
    const campanaSet = new Set(campanas)
    const agenciaSet = new Set(agencias)
    const cache = new Map<string, boolean>()
    return (adId: string) => {
      const hit = cache.get(adId)
      if (hit !== undefined) return hit
      const ok =
        (campanaSet.size === 0 || campanaSet.has(campaignNameOfAd(metaPanel.ctx, adId)?.trim() ?? "")) &&
        (agenciaSet.size === 0 || agenciaSet.has(agenciaOfAd(metaPanel.ctx, adId) ?? NO_AGENCIA))
      cache.set(adId, ok)
      return ok
    }
  }, [metaPanel, panelFilters?.campanas, panelFilters?.agencias])

  const inv = useMemo(() => {
    if (!metaPanel) return null
    const scopedDaily = scopeMetaDaily(metaPanel.meta, metaPanel.desarrolloByAd, panel, pipelines)
    return buildPautaInvestment({
      opportunities: scopeOpportunities(opportunities, panel, pipelines),
      daily: spendFilter ? scopedDaily.filter((d) => spendFilter(d.adId)) : scopedDaily,
      range,
      ctx: metaPanel.ctx,
      contactsWithCita,
      accountIds,
    })
  }, [metaPanel, opportunities, panel, pipelines, range, contactsWithCita, accountIds, spendFilter])

  const oppById = useMemo(() => new Map(allOpportunities.map((o) => [o.id, o])), [allOpportunities])
  const openIds = (ids: string[], title: string, subtitle: string) => {
    const items = ids.map((id) => oppById.get(id)).filter((o): o is Opportunity => Boolean(o))
    if (items.length === 0) return
    setDrill({ open: true, title, subtitle, opportunities: items })
  }
  const drillMetrics = (key: PautaDrillKey, title: string, m: PautaMetrics) =>
    openIds(m.oppIds[key], title, `Embudo ${scope.label} · cohorte por fecha de creación`)

  const revoked = metaWarning?.reason === "token_revoked" || metaWarning?.reason === "token_unreadable"
  const partial = metaWarning?.kind === "partial" ? (metaWarning.reason ?? "") : null
  const accountNames = (ids: string) =>
    ids
      .split(",")
      .map((id) => metaPanel?.index.accountsById.get(id.trim())?.name?.trim() || id.trim())
      .filter(Boolean)
      .join(", ")

  const viaTotal = inv ? inv.via.adId + inv.via.campaignId + inv.via.url + inv.via.post + inv.via.name : 0

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Inversión y rendimiento de pauta"
        icon={Coins}
        total={inv?.kpi.leadsCrm}
        actions={
          <ScopePill
            label="cohorte por fecha"
            tooltip={
              <>
                <strong>Gasto</strong>: lo que Meta reportó en los días del periodo
                {desarrollo ? (
                  <>
                    {" "}
                    para las cuentas publicitarias de <strong>{desarrollo}</strong>
                  </>
                ) : null}
                . <strong>Leads CRM</strong>: oportunidades del embudo <strong>{scope.label}</strong> creadas
                en el periodo y atadas a un anuncio o campaña de Meta por, en este orden, su <em>ad id</em>,
                el id de campaña de la atribución, la URL con la que entraron, o el nombre de la pauta. Cada
                oportunidad entra por un solo nivel. <strong>Citas</strong> es etapa 04 o posterior, ganada,
                o una cita en el objeto Citas; <strong>Visitas</strong> es 05 o ganada;{" "}
                <strong>Ventas</strong> es ganada. Los costos son gasto ÷ resultados de esta cohorte: con un
                ciclo de meses, el costo por venta de un periodo reciente siempre sale alto. Los filtros{" "}
                <strong>Campaña</strong> y <strong>Agencia</strong> acotan también el gasto (por el nombre de
                la campaña de Meta y por la agencia de su nomenclatura); asesor, origen y canal acotan solo los
                leads, porque el gasto no sabe de asesores.
              </>
            }
          />
        }
      />
      <ChartCardContent className="flex flex-col gap-4">
        {!metaPanel ? (
          <ChartEmpty
            message={
              revoked
                ? 'Meta desconectado: reconecta desde la píldora "Meta" del encabezado.'
                : 'Sin conexión con Meta Ads. Conéctala desde la píldora "Meta" del encabezado para ver el gasto.'
            }
          />
        ) : !inv || (inv.kpi.spend === 0 && inv.kpi.leadsCrm === 0) ? (
          <ChartEmpty message="Sin gasto ni leads de pauta en el periodo seleccionado" />
        ) : (
          <>
            {(revoked || partial) && (
              <p className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
                {revoked
                  ? 'Meta desconectado: se muestra el último gasto sincronizado. Reconecta desde la píldora "Meta".'
                  : `En el último sync no respondieron las cuentas ${accountNames(partial ?? "")}; su gasto falta aquí.`}
              </p>
            )}
            {inv.mixedCurrency && (
              <p className={cn("text-[11px]", MISSING_TEXT)}>
                Las cuentas mezclan monedas: los totales van sin símbolo y los costos por resultado se apagan.
              </p>
            )}
            <PautaInvestmentKpis inv={inv} onDrill={(key, title) => drillMetrics(key, title, inv.kpi)} />
            <PautaInvestmentTable inv={inv} onDrill={drillMetrics} />
            <p className="border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
              {n(viaTotal)} {viaTotal === 1 ? "lead entró" : "leads entraron"} por ad id ({n(inv.via.adId)}), id de
              campaña ({n(inv.via.campaignId)}), URL ({n(inv.via.url)}), post del anuncio ({n(inv.via.post)}) o
              nombre ({n(inv.via.name)})
              {inv.noAdId.count > 0 && (
                <>
                  ;{" "}
                  <button
                    type="button"
                    onClick={() =>
                      openIds(inv.noAdId.oppIds, "Leads de pauta sin vincular a Meta", `Embudo ${scope.label}`)
                    }
                    className={cn("font-medium underline-offset-2 hover:underline", MISSING_TEXT)}
                  >
                    {n(inv.noAdId.count)} de pauta
                  </button>{" "}
                  no se pudieron vincular
                </>
              )}
              {inv.unknownAd.count > 0 && (
                <>
                  ;{" "}
                  <button
                    type="button"
                    onClick={() =>
                      openIds(
                        inv.unknownAd.oppIds,
                        "Leads con ad id de una cuenta no conectada",
                        `Embudo ${scope.label}`
                      )
                    }
                    className={cn("font-medium underline-offset-2 hover:underline", MISSING_TEXT)}
                  >
                    {n(inv.unknownAd.count)}
                  </button>{" "}
                  traen un ad id de una cuenta no conectada (revisa &quot;Cambiar cuentas&quot; en la píldora
                  Meta)
                </>
              )}
              {inv.otherAccount.count > 0 && (
                <>
                  ;{" "}
                  <button
                    type="button"
                    onClick={() =>
                      openIds(inv.otherAccount.oppIds, "Leads de anuncios de otra cuenta", `Embudo ${scope.label}`)
                    }
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {n(inv.otherAccount.count)}
                  </button>{" "}
                  vienen de anuncios de otra cuenta publicitaria y no entran al costo de esta pestaña
                </>
              )}
              {inv.unlinkedSpend > 0 && (
                <>
                  ; hay gasto de anuncios eliminados sin campaña conocida (fila <em>Sin campaña</em>)
                </>
              )}
              . Gasto desde{" "}
              {locationCreatedAt
                ? `la creación de la subcuenta (${localDay(locationCreatedAt)})`
                : "el mes en curso, porque GHL no devolvió la fecha de creación de la subcuenta"}
              {metaPanel.mixedAds.length > 0 && desarrollo === null && (
                <>
                  ; {n(metaPanel.mixedAds.length)} anuncios tienen leads en más de un desarrollo y su gasto no
                  se reparte
                </>
              )}
              .
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
