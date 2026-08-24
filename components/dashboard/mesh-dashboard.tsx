"use client"

import type {
  Opportunity,
  Contact,
  Pauta,
  Task,
  Call,
  Appointment,
  Pipeline,
  Message,
} from "@/lib/types"
import type { ResolvedDateRange } from "@/lib/date-range"
import type { ActivityStatus } from "@/hooks/use-conversation-activity"
import { DashboardShell } from "./dashboard-ui"
import { SalesPivotTable } from "./sales-pivot-table"
import { SalesByDimensionChart } from "./sales-by-dimension-chart"
import { LostByDimensionChart } from "./lost-by-dimension-chart"
import { OpportunityStatusChart } from "./opportunity-status-chart"
import { OpportunityWinRateChart } from "./opportunity-win-rate-chart"
import { CanalDeContactoChart, OrigenDeLeadChart } from "./category-breakdown-chart"
import { AdvisorStageTable } from "./advisor-stage-table"
import { AssignmentFunnelChart } from "./assignment-funnel-chart"
import { StaleOpportunityMatrix } from "./stale-opportunity-matrix"
import { TaskBacklogChart } from "./task-backlog-chart"
import { LostReasonMatrix } from "./lost-reason-matrix"
import { LostCrossMatrix } from "./lost-cross-matrix"

/**
 * MESH — the second business line: the coworking brand under Grupo VAEO
 * (private offices, coworking floor, meeting rooms; Monterrey).
 *
 * Same contract as the VAEO panel: charts were cleared to be rebuilt, but the
 * prop surface is kept so `app/page.tsx` keeps feeding the date-filtered
 * dataset plus the unfiltered `all*` lookup sets.
 *
 * Keep the filtered / `all*` pairing when you add drill-downs: charts read the
 * date-filtered arrays, joins resolve against the unfiltered ones (a record can
 * be created outside the window that puts its counterpart on screen).
 */
export interface MeshDashboardProps {
  opportunities: Opportunity[]
  /** Unfiltered opportunities — lookup table for drill-down joins. */
  allOpportunities?: Opportunity[]
  contacts: Contact[]
  /** Unfiltered contacts — lookup table for drill-down joins. */
  allContacts?: Contact[]
  pautas?: Pauta[]
  /** Unfiltered pautas — needed for per-contact history ranking. */
  allPautas?: Pauta[]
  pipelines?: Pipeline[]
  tasks?: Task[]
  /** Tareas SIN filtrar por fecha — el rezago se mide contra hoy, no contra el periodo. */
  allTasks?: Task[]
  /**
   * Oportunidades crudas: sin filtros de panel ni toggle de HubSpot. Solo para
   * distinguir al contacto que NO tiene ninguna oportunidad del que sí tiene
   * pero quedó fuera de un filtro. No la uses para agregar nada.
   */
  unfilteredOpportunities?: Opportunity[]
  /** Contacto → ISO del último mensaje saliente. Ausente = sin dato = cubeta más profunda. */
  conversationActivity?: Map<string, string | null>
  /** El mapa vacío NO significa "nadie escribió": hasta "ready" no se pinta la matriz. */
  activityStatus?: ActivityStatus
  onRetryActivity?: () => void
  calls?: Call[]
  messages?: Message[]
  /** Unfiltered messages — lookup table for conversation drawers. */
  allMessages?: Message[]
  appointments?: Appointment[]
  /** Unfiltered appointments — lookup table for the "Citas" drawer. */
  allAppointments?: Appointment[]
  members?: string[]
  locationId?: string
  /** Sub-account name, used in an exported report's filename. */
  locationName?: string
  /** Human label of the active date filter, for report covers. */
  periodLabel?: string
  /**
   * Resolved global date range. Charts that measure a date OTHER than createdAt
   * (the pivot table measures the close date) filter the `all*` sets themselves
   * instead of using the pre-filtered props.
   */
  dateRange?: ResolvedDateRange | null
}

export function MeshDashboard({
  opportunities,
  contacts,
  allContacts = [],
  allOpportunities = [],
  pipelines = [],
  dateRange = null,
  tasks = [],
  allTasks = [],
  unfilteredOpportunities = [],
  conversationActivity,
  activityStatus = "loading",
  onRetryActivity,
  calls = [],
  allPautas = [],
  appointments = [],
  messages = [],
  locationId,
}: MeshDashboardProps) {
  // Mismo bloque que en el panel VAEO, con el embudo cambiado: los dos paneles
  // son los mismos gráficos sobre pipelines distintos.
  const shared = {
    panel: "mesh" as const,
    opportunities,
    allOpportunities,
    contacts,
    allContacts,
    pipelines,
    tasks,
    calls,
    allPautas,
    appointments,
    messages,
    locationId,
  }

  return (
    <DashboardShell>
      <SalesPivotTable
        panel="mesh"
        allOpportunities={allOpportunities}
        contacts={contacts}
        allContacts={allContacts}
        pipelines={pipelines}
        dateRange={dateRange}
        tasks={tasks}
        calls={calls}
        allPautas={allPautas}
        appointments={appointments}
        messages={messages}
        locationId={locationId}
      />
      {/* Mismo par de charts que en VAEO: solo cambia el embudo y, con él, el
          campo de sucursal ("Sucursal MESH"), que resuelve PANEL_SCOPES. Sus
          totales cuadran con los de la tabla de arriba. */}
      <div className="grid gap-5 lg:grid-cols-2">
        <SalesByDimensionChart {...shared} dimension="sucursal" dateRange={dateRange} />
        <SalesByDimensionChart {...shared} dimension="servicio" dateRange={dateRange} />
      </div>
      {/* El espejo de la de al lado: el mismo apilado por servicio, pero sobre
          los leads que NO se ganaron y sobre el mes en que nos buscaron. El eje
          tiene que ser el de creación —una perdida nunca tiene Fecha de Cierre—
          y hoy su segmento gris domina, que es justo lo que la tarjeta reporta. */}
      <LostByDimensionChart {...shared} dimension="servicio" />
      <OpportunityStatusChart {...shared} />
      <OpportunityWinRateChart {...shared} />
      <AssignmentFunnelChart {...shared} />
      <AdvisorStageTable {...shared} />
      <StaleOpportunityMatrix
        {...shared}
        conversationActivity={conversationActivity}
        activityStatus={activityStatus}
        onRetryActivity={onRetryActivity}
      />
      <TaskBacklogChart
        {...shared}
        allTasks={allTasks}
        unfilteredOpportunities={unfilteredOpportunities}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <OrigenDeLeadChart {...shared} />
        <CanalDeContactoChart {...shared} />
      </div>
      <LostReasonMatrix {...shared} />
      <LostCrossMatrix {...shared} />
    </DashboardShell>
  )
}
