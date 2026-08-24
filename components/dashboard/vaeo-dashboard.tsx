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
 * VAEO — one of the two business lines (oficinas virtuales / oficinas equipadas
 * / salas de juntas, the original Business Club brand).
 *
 * The charts were cleared to be rebuilt from scratch for this client. The prop
 * surface is kept intact on purpose: `app/page.tsx` still feeds the full,
 * date-filtered dataset plus the unfiltered `all*` lookup sets, so a new chart
 * only has to be dropped in — no plumbing to redo.
 *
 * Keep the filtered / `all*` pairing when you add drill-downs: charts read the
 * date-filtered arrays, joins resolve against the unfiltered ones (a record can
 * be created outside the window that puts its counterpart on screen).
 */
export interface VaeoDashboardProps {
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

export function VaeoDashboard({
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
}: VaeoDashboardProps) {
  // Todo lo que los tres gráficos por-oportunidad necesitan es idéntico, así que
  // se arma una sola vez. El panel MESH rinde exactamente los mismos con
  // panel="mesh"; si esto crece, extráelo antes de que las dos listas diverjan.
  const shared = {
    panel: "vaeo" as const,
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
        panel="vaeo"
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
      {/* La misma agregación que la tabla de arriba, en otra forma: los totales
          tienen que cuadrar con ella al centavo. */}
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
      {/* Las mismas perdidas, la otra pregunta: no por qué se cayeron sino qué
          se les estaba vendiendo y por dónde habían llegado. */}
      <LostCrossMatrix {...shared} />
    </DashboardShell>
  )
}
