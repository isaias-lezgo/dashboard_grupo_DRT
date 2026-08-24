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
import type { PanelId } from "@/lib/panel-scope"
import { DashboardShell } from "./dashboard-ui"
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
 * El panel, una sola vez, para los siete alcances: GENERAL y los seis
 * desarrollos.
 *
 * Antes esto eran dos archivos gemelos (uno por línea de negocio) que solo
 * diferían en un literal, con un comentario que pedía extraerlos "antes de que
 * las dos listas diverjan". Con siete alcances la duplicación ya no era
 * sostenible: `panel` es una prop y `lib/panel-scope.ts` decide qué embudo
 * significa. Agregar un desarrollo es agregar una entrada en PANEL_SCOPES, no
 * un archivo.
 *
 * Conserva el emparejamiento filtradas / `all*` cuando agregues drill-downs: los
 * gráficos leen los arreglos ya cortados por fecha, y los joins se resuelven
 * contra los sin filtrar (un registro puede haberse creado fuera de la ventana
 * que pone a su contraparte en pantalla).
 */
export interface PanelDashboardProps {
  /** Qué alcance dibuja este panel. GENERAL no acota a ningún embudo. */
  panel: PanelId
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
   * Oportunidades crudas: sin los filtros de la barra. Solo para distinguir al
   * contacto que NO tiene ninguna oportunidad del que sí tiene pero quedó fuera
   * de un filtro. No la uses para agregar nada.
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
   * filter the `all*` sets themselves instead of using the pre-filtered props.
   */
  dateRange?: ResolvedDateRange | null
}

export function PanelDashboard({
  panel,
  opportunities,
  contacts,
  allContacts = [],
  allOpportunities = [],
  pipelines = [],
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
}: PanelDashboardProps) {
  // Todo lo que los gráficos por-oportunidad necesitan es idéntico, así que se
  // arma una sola vez y se derrama. Mantén ese patrón en vez de volver a listar
  // props por gráfico.
  const shared = {
    panel,
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
      <OpportunityStatusChart {...shared} />
      <OpportunityWinRateChart {...shared} />
      {/* De las oportunidades de DRT ~17% no tienen asesor asignado, así que
          esta tarjeta no es un detalle: es la fuga más grande del embudo. */}
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
      {/* Las mismas perdidas, la otra pregunta: no por qué se cayeron sino por
          dónde habían llegado. */}
      <LostCrossMatrix {...shared} />
    </DashboardShell>
  )
}
