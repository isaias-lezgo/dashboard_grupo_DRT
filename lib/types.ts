// Internal types — full GHL API shape + computed/resolved additions.
// Fields marked "computed" are added by the dashboard API route (not from GHL directly).

export interface Contact {
  // Always present (normalized by transform)
  id: string
  name: string
  email: string
  phone: string
  tags: string[]
  dateAdded: string
  createdAt: string   // computed: alias for dateAdded

  // GHL Contact fields
  locationId?: string
  firstName?: string
  lastName?: string
  emailLowerCase?: string
  timezone?: string
  companyName?: string
  dnd?: boolean
  dndSettings?: Record<string, unknown>
  type?: string
  address1?: string
  city?: string
  state?: string
  country?: string
  postalCode?: string
  website?: string
  dateOfBirth?: string
  dateUpdated?: string
  lastActivity?: string
  customFields?: Array<{ id: string; value: string }>
  // computed: name→value resolved custom fields. Multi-option/checkbox fields
  // keep their array shape; single-value fields are stored as a plain string.
  customFieldsResolved?: Record<string, string | string[]>
  businessId?: string
  visitorId?: string
  keyword?: string
  firstNameLowerCase?: string
  fullNameLowerCase?: string
  lastNameLowerCase?: string
  attachments?: unknown[]
  ssn?: string
  assignedTo?: string   // GHL field; resolved to user name by transform
  attributionSource?: { [key: string]: string | undefined }
  lastAttributionSource?: { [key: string]: string | undefined }
  attributions?: Array<{ [key: string]: unknown }>

  // Computed attribution (derived from attributions array)
  source?: string
  campaign?: string
  campaignName?: string // computed: utmCampaign alone (the ad campaign / "pauta" identity)
  adType?: string
  adId?: string
  attributionUrl?: string
  attributionMedium?: string
}

export interface Opportunity {
  // Always present
  id: string
  name: string
  pipelineId: string
  pipelineStageId: string
  status: "open" | "won" | "lost" | "abandoned"
  createdAt: string

  // Computed/resolved (always set by transform)
  contactId: string     // computed: from embedded contact.id or direct contactId
  value: number         // computed: monetaryValue ?? 0
  stage: string         // computed: resolved from pipelineStageId via pipeline lookup
  pipelineName: string  // computed: resolved from pipelineId via pipeline lookup

  // GHL Opportunity fields
  locationId?: string
  userId?: string
  assignedTo?: string   // GHL field; resolved to user name by transform
  statusId?: string
  monetaryValue?: number
  currency?: string
  probability?: number
  closedAt?: string
  updatedAt?: string
  /** Última vez que la oportunidad cambió de ETAPA. La señal honesta de movimiento. */
  lastStageChangeAt?: string
  lastStatusChangeAt?: string
  source?: string
  campaignId?: string
  funnelId?: string
  workflowId?: string
  tags?: string[]       // opportunity's own tags (not from contact)
  priority?: string
  notes?: string
  archived?: boolean
  origin?: string
  lastActivity?: string
  lostReasonId?: string
  lostReason?: string   // computed (resolveLostReason): native lostReasonId → the location's lost-reason catalog, else a "Motivo/Razón de Perdido" custom field
  customFields?: Array<{ id: string; key?: string; value?: string; fieldValue?: string; fieldValueString?: string; type?: string }>
  // computed: name→value resolved custom fields. Multi-option/checkbox fields
  // keep their array shape; single-value fields are stored as a plain string.
  customFieldsResolved?: Record<string, string | string[]>
  attributions?: Array<{ [key: string]: unknown }>

  // Embedded contact object from search endpoint
  contact?: { id: string; name?: string; email?: string; phone?: string; tags?: string[] }

  // Computed attribution (derived from attributions array)
  campaign?: string
  campaignName?: string // computed: utmCampaign alone (the ad campaign / "pauta" identity)
  adType?: string
  adId?: string
  attributionUrl?: string
  attributionMedium?: string  // computed: GHL-internal medium (whatsapp, instagram, calendar, manual, …) or utmSessionSource fallback
  originPlatform?: string     // computed: linked contact's "Origen de Lead" custom field (Instagram/Facebook/TikTok/…); fallback signal for platformLabel
}

export interface Call {
  id: string
  contactId: string
  assignedTo?: string
  direction: "inbound" | "outbound"
  status: "completed" | "missed" | "no-answer"
  durationSeconds: number
  createdAt: string
}

export interface Task {
  id: string
  title: string
  body?: string
  status: "pending" | "completed"
  dueDate?: string
  contactId: string
  contactName?: string
  opportunityId?: string
  assignedTo?: string
  assignedToName?: string
  createdAt?: string
}

export interface Appointment {
  id: string
  contactId: string
  assignedTo?: string
  title?: string
  startTime: string
  endTime: string
  status: string
  notes?: string
  location?: string
}

// Channels we can render with an icon/label in the thread.
// Anything else collapses to "other".
export type MessageChannel =
  | "sms"
  | "email"
  | "facebook"
  | "instagram"
  | "whatsapp"
  | "google_chat"
  | "call"
  | "webchat"
  | "live_chat"
  | "tiktok"
  | "review"
  | "form_submission"
  | "internal_comment"
  | "other"

// System / activity event kinds — rendered as a centered timeline chip,
// not a chat bubble.
export type ActivityKind =
  | "opportunity"
  | "appointment"
  | "invoice"
  | "payment"
  | "contact"
  | "employee_action"
  | "other"

export interface Message {
  id: string
  contactId: string
  conversationId?: string
  assignedTo?: string
  direction: "inbound" | "outbound"
  // Omitted = real message. "activity" = system event (rendered as a chip).
  kind?: "message" | "activity"
  // For messages: the channel. For activities: "system".
  source: MessageChannel | "system"
  // Only set on activities — drives the chip label.
  activityKind?: ActivityKind
  content?: string
  createdAt: string
}

export interface Pipeline {
  id: string
  name: string
  stages: string[]
}


export interface Pauta {
  id: string
  tipo: string
  nombrePauta: string
  createdAt: string
  contactId?: string
  properties?: Record<string, string>
}

/**
 * A dataset that did not come back clean in the last sync.
 * `partial` = some pages never landed; `error` = nothing came back at all.
 * Neither is the same as a legitimate zero, which produces no warning.
 *
 * Declared here rather than in the route or the hook because both sides consume
 * it, and two copies would drift. `key` stays a plain string on purpose: tying
 * it to the hook's StepKey would pull client types into lib/.
 */
export interface SyncWarning {
  key: string
  kind: "partial" | "error"
  loaded: number
  /** Total the API reported, when it reported one. */
  expected?: number
}

/**
 * Everything one full sync produces: exactly the body of the `data` frame, minus
 * its `type`. Declared here — not in the route and not in the hook — because
 * three places now consume it (lib/sync.ts returns it, lib/sync-store.ts gzips
 * it into Postgres, the browser renders it) and three copies would drift.
 *
 * `warnings` is part of the payload, not a property of the live stream: a warm
 * load served from cache must still raise the amber banner for a dataset that
 * came back incomplete during the sync that filled it.
 */
export interface DashboardPayload {
  contacts: Contact[]
  opportunities: Opportunity[]
  calls: Call[]
  tasks: Task[]
  appointments: Appointment[]
  pipelines: Pipeline[]
  members: string[]
  tags: string[]
  campaigns: string[]
  sources: string[]
  pautas: Pauta[]
  locationId: string
  locationName: string
  /** Datasets that came back incomplete or empty. Optional so a `data` frame
   *  from an older deploy (a tab left open through a release) still parses. */
  warnings?: SyncWarning[]
  meta: {
    totalContacts: number
    totalOpportunities: number
    /** When the data was pulled from GHL — the clock behind "Actualizado hace X"
     *  and the value stored in `project_sync.synced_at`. */
    fetchedAt: string
  }
}
