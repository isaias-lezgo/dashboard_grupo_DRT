"use client"

import { useMemo, useState } from "react"
import { Filter, Info } from "lucide-react"
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
import { buildStageFunnel, type FunnelStep } from "@/lib/desarrollo-funnel"
import { PANEL_SCOPES, scopeOpportunities, type PanelId } from "@/lib/panel-scope"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  BRAND_AMBER,
  ChartCardContent,
  ChartCardHeader,
  ChartEmpty,
  ChartHint,
  DashboardCard,
  ScopePill,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"

const pctFmt = new Intl.NumberFormat("es-MX", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

export interface StageFunnelChartProps {
  panel: PanelId
  /** Oportunidades ya filtradas por la barra y por fecha. */
  opportunities: Opportunity[]
  /** Sin filtrar — los joins del drawer se resuelven contra estas. */
  allOpportunities: Opportunity[]
  /**
   * Citas SIN filtrar por fecha. La cita de una oportunidad en pantalla puede
   * estar agendada fuera de la ventana; con las filtradas se perdería.
   */
  allAppointments: Appointment[]
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
 * El embudo de seis pasos que mide la estrategia: leads → precalificados →
 * citas → visitas → apartados → ventas. Cada barra es el % sobre leads totales;
 * la conversión paso a paso va como texto porque es la que importa (Visita →
 * Apartado es la bisagra de este negocio) y porque una barra al 0.5% no se lee
 * sin su número.
 *
 * HTML puro, sin Recharts: seis filas fijas no ganan nada con un eje.
 */
export function StageFunnelChart({
  panel,
  opportunities,
  allOpportunities,
  allAppointments,
  contacts,
  allContacts,
  pipelines = [],
  tasks = [],
  calls = [],
  allPautas = [],
  appointments = [],
  messages = [],
  locationId = "",
}: StageFunnelChartProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  const scoped = useMemo(
    () => scopeOpportunities(opportunities, panel, pipelines),
    [opportunities, panel, pipelines]
  )
  const steps = useMemo(
    () => buildStageFunnel(scoped, allAppointments),
    [scoped, allAppointments]
  )
  const leads = steps[0]?.count ?? 0

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  const openDrill = (step: FunnelStep) => {
    const items = step.ids
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    if (items.length === 0) return
    setDrill({
      open: true,
      title: `${step.n}. ${step.label}`,
      subtitle: `Embudo ${scope.label} · ${pctFmt.format(step.pctOfTotal)}% de los leads`,
      opportunities: items,
    })
  }

  const citas = steps.find((s) => s.key === "citas")

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Embudo de la estrategia"
        icon={Filter}
        total={leads}
        actions={
          <ScopePill
            label="6 pasos por etapa alcanzada"
            tooltip={
              <>
                Cada paso cuenta las oportunidades del embudo <strong>{scope.label}</strong> cuya
                etapa actual es esa o una posterior: una perdida en <em>05. Visita</em> sí contó
                como cita y como visita. <strong>Precalificados</strong> es <em>02. Lead en
                Seguimiento</em> en adelante; <strong>Citas agendadas</strong> suma además a
                quien tiene una cita en el calendario del CRM aunque su oportunidad no se haya
                movido (ver el ⓘ de esa fila); <strong>Ventas</strong> son las ganadas. Alcanzar
                un paso implica los anteriores, así que el embudo nunca se ensancha.
              </>
            }
          />
        }
      />
      <ChartCardContent>
        {leads === 0 ? (
          <ChartEmpty message="Sin oportunidades en el periodo seleccionado" />
        ) : (
          <>
            <ol className="flex flex-col gap-1.5">
              {steps.map((step) => (
                <li key={step.key}>
                  <button
                    type="button"
                    onClick={() => openDrill(step)}
                    disabled={step.count === 0}
                    className="group grid w-full grid-cols-[1.5rem_minmax(8rem,11rem)_1fr_auto] items-center gap-2 rounded-sm px-1 py-1 text-left transition-colors enabled:hover:bg-muted/50 disabled:cursor-default"
                  >
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-sm bg-muted text-[11px] font-medium tabular-nums text-muted-foreground">
                      {step.n}
                    </span>
                    <span className="flex min-w-0 items-center gap-1 text-xs text-foreground">
                      <span className="truncate">{step.label}</span>
                      {step.key === "citas" && citas?.fuentes && (
                        <CitasInfo fuentes={citas.fuentes} />
                      )}
                    </span>
                    <span className="h-5 w-full overflow-hidden rounded-sm bg-muted/60">
                      {step.count > 0 && (
                        <span
                          className="block h-full rounded-sm transition-[width] duration-300"
                          style={{
                            width: `${Math.max(step.pctOfTotal, 1.5)}%`,
                            backgroundColor: BRAND_AMBER,
                          }}
                        />
                      )}
                    </span>
                    <span className="whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {step.count.toLocaleString("es-MX")}
                      </span>{" "}
                      · {pctFmt.format(step.pctOfTotal)}%
                      {step.pctOfPrev !== null && (
                        <span className="hidden text-[11px] sm:inline">
                          {" "}
                          · {pctFmt.format(step.pctOfPrev)}% del anterior
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <ChartHint>
              Porcentajes sobre {leads.toLocaleString("es-MX")} leads totales. Una conversión
              del orden de 1% es normal en este giro: el paso que más dice es Visita → Apartado.
            </ChartHint>
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

/**
 * El ⓘ de "Citas agendadas": el único paso que mezcla dos fuentes, y el
 * desglose de cuánto aportó cada una. Va dentro del botón de la fila, así que
 * detiene el click para no abrir el drawer al tocarlo.
 */
function CitasInfo({ fuentes }: { fuentes: NonNullable<FunnelStep["fuentes"]> }) {
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="button"
            tabIndex={0}
            aria-label="Cómo se cuenta una cita agendada"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className="inline-flex shrink-0 text-muted-foreground/70 hover:text-foreground"
          >
            <Info className="h-3 w-3" aria-hidden />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[18rem] text-xs leading-relaxed">
          Una oportunidad cuenta como cita agendada si <strong>cualquiera</strong> de dos
          señales se cumple: su etapa es <em>04. Cita Programada</em> o posterior (
          {fuentes.porEtapa.toLocaleString("es-MX")}), o su contacto tiene una cita en el objeto{" "}
          <strong>Citas</strong> del CRM, con cualquier estatus, aunque la oportunidad siga en
          una etapa anterior ({fuentes.soloPorCita.toLocaleString("es-MX")} solo por esta vía).
          Se mezclan porque hay asesoras que agendan en el calendario sin mover la oportunidad
          y otras que la mueven sin usar el calendario.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
