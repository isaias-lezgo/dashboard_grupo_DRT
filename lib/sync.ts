// lib/sync.ts
// El sync de GHL: todo lo que va entre "ya sé de qué cliente hablamos" y "aquí
// está el payload completo del dashboard". Extraído de app/api/dashboard/route.ts
// para que la ruta y el refresco en segundo plano llamen al MISMO código — dos
// copias de esto se desincronizarían al primer cambio.
//
// No sabe nada de HTTP, streams ni caché. Reporta progreso por `send` (opcional:
// el refresco en segundo plano no tiene a quién mandarle progreso) y devuelve el
// payload; quien lo llamó decide qué hacer con él.
import {
  getAllContacts,
  getAllOpportunities,
  getPipelines,
  getUsers,
  getCustomFields,
  getLostReasons,
  getCustomObjects,
  getAllCustomObjectRecords,
  getCalendarEvents,
  getCalendars,
  getLocation,
  searchLocationTasks,
  type GHLContact,
  type GHLOpportunity,
  type GHLCalendarEvent,
  type GHLTask,
} from "@/lib/ghl-client";
import { withClient } from "@/lib/ghl-context";
import type { ClientConfig } from "@/lib/clients";
import type { PagedResult } from "@/lib/paged-fetch";
import type {
  Contact,
  Opportunity,
  Call,
  Task,
  Pipeline,
  Pauta,
  Appointment,
  SyncWarning,
  DashboardPayload,
} from "@/lib/types";

type Attribution = {
  isFirst?: boolean;
  utmCampaign?: string;
  utmContent?: string;
  utmMedium?: string;
  utmSource?: string;
  utmSessionSource?: string;
  adSource?: string;
  medium?: string;
  utmAdId?: string;
  url?: string;
  [key: string]: unknown;
};

function firstAttr(attributions?: Attribution[]): Attribution | undefined {
  if (!attributions?.length) return undefined;
  return attributions.find((a) => a.isFirst) ?? attributions[0];
}

function buildCampaignLabel(content?: string, campaign?: string): string | undefined {
  const parts = [content, campaign].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

function resolveCustomFields(
  fields:
    | Array<{
        id: string;
        value?: unknown;
        fieldValue?: unknown;
        fieldValueString?: unknown;
        fieldValueDate?: unknown;
      }>
    | undefined,
  map: Map<string, string>
): Record<string, string | string[]> {
  if (!fields?.length || !map.size) return {};
  const result: Record<string, string | string[]> = {};
  for (const f of fields) {
    const name = map.get(f.id);
    if (!name) continue;
    // contacts use value; opportunities use fieldValue/fieldValueString.
    // Multi-option/checkbox fields arrive as an array of strings.
    // GHL DATE fields use NONE of those three — they arrive as fieldValueDate,
    // an epoch in milliseconds at UTC midnight. Normalized to ISO here so
    // consumers never have to know the field was a date; customFieldsResolved
    // stays string-valued.
    const raw = f.fieldValue ?? f.fieldValueString ?? f.value ?? f.fieldValueDate;
    if (raw === undefined || raw === null) continue;
    if (f.fieldValueDate != null && raw === f.fieldValueDate) {
      const ms = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(ms)) continue;
      result[name] = new Date(ms).toISOString();
      continue;
    }
    if (Array.isArray(raw)) {
      const arr = raw.map((v) => String(v)).filter((s) => s.trim() !== "");
      if (arr.length === 1) result[name] = arr[0];
      else if (arr.length > 1) result[name] = arr;
    } else {
      const s = String(raw);
      if (s.trim() !== "") result[name] = s;
    }
  }
  return result;
}

// Narrow a resolved custom field to a single string (for scalar fields like
// "Motivo de Perdido"). Multi-value fields collapse to their first entry.
function cfString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v || undefined;
}

// Name variants a sub-account might give the custom field that stores the loss
// motive. Ordered fallback, mirroring resolveCampaignName() in lib/pauta.ts —
// accounts name this differently ("Motivo de Perdido" vs "Razón de Perdido"),
// with/without accents. Only consulted when the native lost reason is absent.
const LOST_REASON_CF_NAMES = [
  "Motivo de Perdido",
  "Motivo de perdido",
  "Motivo de Pérdida",
  "Motivo de pérdida",
  "Razón de Perdido",
  "Razón de perdido",
  "Razón de Pérdida",
  "Razón de pérdida",
  "Razon de Perdido",
  "Razon de perdido",
] as const;

// Resolve an opportunity's loss reason. Precedence:
//   1. GHL's native lost reason — `lostReasonId` looked up in the location's
//      lost-reason catalog. This is what GHL's own "Lost reason:" UI shows and
//      is populated by the client sub-accounts (Condesa, Grand Center, …).
//   2. A custom field, under any of the LOST_REASON_CF_NAMES aliases, for
//      accounts that record the motive in a field instead of the native one.
// Only meaningful when status is "lost".
function resolveLostReason(
  lostReasonId: string | undefined,
  lostReasonMap: Map<string, string>,
  customFieldsResolved: Record<string, string | string[]>
): string | undefined {
  const native = lostReasonId ? lostReasonMap.get(lostReasonId) : undefined;
  if (native) return native;
  for (const name of LOST_REASON_CF_NAMES) {
    const cf = cfString(customFieldsResolved[name]);
    if (cf) return cf;
  }
  return undefined;
}

// Spread all GHL fields through; add computed fields on top.
function transformContact(ghl: GHLContact, customFieldMap: Map<string, string>): Contact {
  const customFieldsResolved = resolveCustomFields(ghl.customFields, customFieldMap);
  const attr = firstAttr(ghl.attributions);
  return {
    ...ghl,
    name:
      ghl.name?.trim() ||
      `${ghl.firstNameRaw ?? ""} ${ghl.lastNameRaw ?? ""}`.trim() ||
      ghl.contactName?.trim() ||
      `${ghl.firstName ?? ""} ${ghl.lastName ?? ""}`.trim() ||
      "Unknown",
    email: ghl.email ?? "",
    phone: ghl.phone ?? "",
    tags: ghl.tags ?? [],
    createdAt: ghl.dateAdded,
    source: attr?.utmSource || attr?.adSource || ghl.source || "direct",
    campaign: buildCampaignLabel(attr?.utmContent, attr?.utmCampaign),
    campaignName: attr?.utmCampaign || undefined,
    adType: attr?.utmMedium || attr?.utmSessionSource,
    adId: attr?.utmAdId || undefined,
    attributionUrl: attr?.url || ghl.attributionSource?.url || undefined,
    attributionMedium: attr?.medium || attr?.utmSessionSource || undefined,
    ...(Object.keys(customFieldsResolved).length > 0 ? { customFieldsResolved } : {}),
  };
}

function transformOpportunity(
  ghl: GHLOpportunity,
  pipelines: Map<string, { name: string; stages: Map<string, string> }>,
  customFieldMap: Map<string, string>,
  lostReasonMap: Map<string, string>
): Opportunity {
  const pipeline = pipelines.get(ghl.pipelineId);
  const stageName = pipeline?.stages.get(ghl.pipelineStageId) || "Unknown";
  const customFieldsResolved = resolveCustomFields(ghl.customFields, customFieldMap);
  const attr = firstAttr(ghl.attributions);

  return {
    ...ghl,
    contactId: ghl.contact?.id || ghl.contactId || "",
    value: ghl.monetaryValue ?? 0,
    stage: stageName,
    pipelineName: pipeline?.name || "Unknown",
    tags: ghl.tags ?? ghl.contact?.tags ?? [],
    source: attr?.utmSource || attr?.adSource || ghl.source,
    campaign: buildCampaignLabel(attr?.utmContent, attr?.utmCampaign),
    campaignName: attr?.utmCampaign || undefined,
    adType: attr?.utmMedium || attr?.utmSessionSource,
    adId: attr?.utmAdId || undefined,
    attributionUrl: attr?.url || undefined,
    attributionMedium: attr?.medium || attr?.utmSessionSource || undefined,
    lostReason:
      ghl.status === "lost"
        ? resolveLostReason(ghl.lostReasonId, lostReasonMap, customFieldsResolved)
        : undefined,
    ...(Object.keys(customFieldsResolved).length > 0 ? { customFieldsResolved } : {}),
  };
}

function transformTask(ghl: GHLTask): Task {
  const assignedFirst = ghl.assignedToUserDetails?.firstName ?? "";
  const assignedLast = ghl.assignedToUserDetails?.lastName ?? "";
  const assignedToName = [assignedFirst, assignedLast].filter(Boolean).join(" ") || undefined;
  const contactFirst = ghl.contactDetails?.firstName ?? "";
  const contactLast = ghl.contactDetails?.lastName ?? "";
  const contactName = [contactFirst, contactLast].filter(Boolean).join(" ") || undefined;
  return {
    id: ghl._id,
    title: ghl.title,
    body: ghl.body,
    status: ghl.completed ? "completed" : "pending",
    dueDate: ghl.dueDate,
    contactId: ghl.contactId,
    contactName,
    assignedTo: ghl.assignedTo,
    assignedToName,
    createdAt: ghl.createdAt ?? ghl.dateAdded,
  };
}

type StepStatus = "loading" | "retrying" | "done" | "partial" | "error";

interface DatasetOutcome<T> {
  key: string;
  records: T[];
  status: "done" | "partial" | "error";
  loaded: number;
  expected?: number;
}

// One GHL rate-limit window — the same pause fanOutPages uses between attempts.
const DATASET_RETRY_PAUSE_MS = 10_000;

// Run one dataset of the sync, emitting its step frames and applying the
// dataset-level safety net.
//
// Two distinct retry levels are in play. The paginated walks already keep
// whatever landed and (for fan-out) retry individual failed pages, which handles
// the common case cheaply. This one only fires when the dataset came back with
// NOTHING salvageable — the very first page failed, so there was nothing for the
// page-level retry to work with.
//
// A dataset that legitimately holds zero records (missingPages empty) is NOT a
// failure and must not trigger the retry: that's a location with no pautas, not
// a broken fetch. Conflating those two is the bug this whole change exists to
// kill, so the distinction is load-bearing.
async function runDataset<T>(
  key: string,
  send: (obj: unknown) => void,
  fetcher: (onProgress: (count: number) => void) => Promise<PagedResult<T>>
): Promise<DatasetOutcome<T>> {
  const step = (status: StepStatus, count?: number) =>
    send({ type: "step", key, status, ...(count !== undefined ? { count } : {}) });

  const attempt = async (): Promise<PagedResult<T> | null> => {
    try {
      return await fetcher((count) => step("loading", count));
    } catch (err) {
      console.error(`[GHL] ${key} fetch failed:`, err);
      return null;
    }
  };

  const salvagedNothing = (r: PagedResult<T> | null) =>
    !r || (r.records.length === 0 && r.missingPages.length > 0);

  let result = await attempt();

  if (salvagedNothing(result)) {
    console.warn(`[GHL] ${key} came back empty — retrying the whole dataset once`);
    step("retrying");
    await new Promise((r) => setTimeout(r, DATASET_RETRY_PAUSE_MS));
    result = await attempt();
  }

  if (salvagedNothing(result)) {
    step("error", 0);
    return { key, records: [], status: "error", loaded: 0, expected: result?.total };
  }

  const r = result as PagedResult<T>;
  const status = r.missingPages.length > 0 ? "partial" : "done";
  step(status, r.records.length);
  return { key, records: r.records, status, loaded: r.records.length, expected: r.total };
}

// Datasets that don't paginate still go through runDataset, so every step frame
// is produced in one place. They are complete by definition.
function asPaged<T>(records: T[]): PagedResult<T> {
  return { records, missingPages: [], missingEstimate: 0 };
}

function resolveContactIdFromRelations(
  relations: import("@/lib/ghl-client").GHLCustomObjectRelation[] | undefined
): string | undefined {
  if (!relations?.length) return undefined;
  const contactRelation = relations.find((r) => r.objectKey === "contact");
  return contactRelation?.recordId ?? undefined;
}

async function fetchAllPautas(
  onProgress?: (count: number) => void
): Promise<PagedResult<Pauta>> {
  try {
    // List all custom objects to find the Pautas schema key
    const schemasResp = await getCustomObjects();
    const stub = schemasResp.objects.find(
      (s) =>
        s.labels.singular.toLowerCase().includes("pauta") ||
        s.labels.plural.toLowerCase().includes("pautas")
    );
    if (!stub) {
      // A location with no Pautas object legitimately has zero pautas — this is
      // NOT a failure, so it must not be flagged (empty missingPages).
      console.warn("[GHL] Pautas custom object schema not found");
      return { records: [], missingPages: [], missingEstimate: 0 };
    }

    const paged = await getAllCustomObjectRecords(stub.key, onProgress);
    const records = paged.records;

    // The property holding the campaign name isn't consistent across sub-accounts —
    // each one named its custom-object field differently. Observed so far:
    //   nombre_pauta        (Lezgo Suite)
    //   nombre_de_pauta     (Condesa, Grand Center)
    //   nombre_de_la_pauta  (Plaza Bosques / Meseta)
    // Try each in order and keep every variant out of the generic `properties` blob
    // so it isn't duplicated. Append new spellings here as accounts are onboarded.
    const NOMBRE_PAUTA_KEYS = ["nombre_pauta", "nombre_de_pauta", "nombre_de_la_pauta"];
    const SKIP_PROPERTY_KEYS = new Set(["tipo", "id", ...NOMBRE_PAUTA_KEYS]);

    const pickNombrePauta = (props: Record<string, unknown>): string => {
      for (const k of NOMBRE_PAUTA_KEYS) {
        const v = props[k];
        if (v !== null && v !== undefined && String(v).trim()) return String(v).trim();
      }
      return "";
    };

    const pautas = records.map((r) => {
      const properties: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.properties)) {
        if (SKIP_PROPERTY_KEYS.has(k)) continue;
        if (v === null || v === undefined) continue;
        const str = Array.isArray(v) ? v.join(", ") : String(v);
        if (str.trim()) properties[k] = str.trim();
      }

      return {
        id: r.id,
        tipo: String(r.properties["tipo"] ?? "") || "Sin tipo",
        nombrePauta: pickNombrePauta(r.properties) || "Sin nombre",
        createdAt: r.createdAt ?? new Date().toISOString(),
        contactId: resolveContactIdFromRelations(r.relations),
        properties,
      };
    });

    // Carry the partiality signal up rather than flattening to a bare array —
    // swallowing it here would undo the whole point of the layer below.
    return {
      records: pautas,
      total: paged.total,
      missingPages: paged.missingPages,
      missingEstimate: paged.missingEstimate,
    };
  } catch (err) {
    // Flag page 1 as missing so runDataset treats this as a failure (and retries)
    // instead of reading it as a legitimately empty location.
    console.error("[GHL] Pautas fetch failed:", err);
    return { records: [], missingPages: [1], missingEstimate: 0 };
  }
}

// Fetch + transform appointments across all calendars over a ±90-day window.
// /calendars/events requires one of (calendarId, userId, groupId); empirically
// GHL doesn't index it on assignedUserId, so userId-based queries return empty.
// Fan out across calendars instead and use each event's assignedUserId for asesor
// attribution. Per-calendar failures are swallowed so one bad calendar doesn't
// blank the chart. Self-contained so it can run concurrently with the other
// top-level fetches; the global limiter in ghl-client paces the combined load.
async function fetchAppointments(userMap: Map<string, string>): Promise<Appointment[]> {
  const appointments: Appointment[] = [];
  try {
    const calsResp = await getCalendars().catch((err: unknown) => {
      console.error("[GHL] Calendars list fetch failed:", err);
      return { calendars: [] };
    });
    const calendarIds = calsResp.calendars.map((c) => c.id);
    if (calendarIds.length === 0) return appointments;

    // /calendars/events expects startTime/endTime as epoch ms strings; ISO
    // strings silently return empty. Window spans 90 days back AND forward:
    // appointments are inherently future-facing, so an end of `now` would
    // silently drop every upcoming appointment.
    const now = Date.now();
    const apptStartTime = String(now - 90 * 86_400_000);
    const apptEndTime = String(now + 90 * 86_400_000);

    // Fan out one request per calendar; ghlFetch's semaphore bounds in-flight
    // count, so we no longer need a hand-rolled worker-pool cursor here.
    const apptBatches = await Promise.all(
      calendarIds.map((calendarId) =>
        getCalendarEvents({ calendarId, startTime: apptStartTime, endTime: apptEndTime })
          .then((resp) => resp.events ?? [])
          .catch((err: unknown) => {
            console.error(`[GHL] Calendar events fetch failed for calendar ${calendarId}:`, err);
            return [] as GHLCalendarEvent[];
          })
      )
    );

    // Dedupe by event id (one event could appear under multiple calendars in
    // theory), then transform.
    const seen = new Set<string>();
    for (const batch of apptBatches) {
      for (const ev of batch) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        const advisorId = ev.assignedUserId;
        const advisorName = advisorId && userMap.has(advisorId) ? userMap.get(advisorId) : advisorId;
        appointments.push({
          id: ev.id,
          contactId: ev.contactId,
          assignedTo: advisorName,
          title: ev.title,
          startTime: ev.startTime,
          endTime: ev.endTime,
          status: (ev.appointmentStatus ?? "").toLowerCase() || "sin estado",
          notes: ev.notes,
          location: ev.address ?? ev.location,
        });
      }
    }
  } catch (err) {
    console.error("[GHL] Appointments fetch failed:", err);
  }
  return appointments;
}

/**
 * Corre un sync completo contra GHL y devuelve el payload del dashboard.
 *
 * `send` es opcional a propósito: el camino en vivo le pasa el emisor del stream
 * NDJSON para que la pantalla de carga avance, y el refresco en segundo plano lo
 * omite porque no tiene a quién hablarle. Las excepciones NO se atrapan aquí —
 * cada llamador decide si eso se convierte en un frame de error para el usuario
 * o en un log más un candado liberado.
 */
export async function syncProject(
  client: ClientConfig,
  send: (obj: unknown) => void = () => {}
): Promise<DashboardPayload> {
  // El contexto de credenciales se entra AQUÍ, no alrededor del handler de la
  // ruta: el stream sigue produciendo frames después de que GET() regresó, así
  // que envolver el handler dejaría la bomba corriendo fuera del contexto (donde
  // currentClient() truena).
  return withClient(client, async () => {
    // Structured per-dataset progress. The client renders one live row per
    // step (status + running count), so the user watches every stream advance
    // in parallel instead of staring at a single flickering line. `progress`
    // text frames are still sent as a human-readable fallback.
    const sendStep = (key: string, status: "loading" | "done", count?: number) =>
      send({ type: "step", key, status, ...(count !== undefined ? { count } : {}) });

    send({ type: "progress", message: "Iniciando sincronización…" });
    sendStep("config", "loading");

    // Resolve the sub-account name first so the loading screen can show which
    // location is being opened. Cheap single call — don't block the rest on it.
    let locationName = "";
    const locationPromise = getLocation()
      .then((res) => {
        const name = res?.location?.name?.trim();
        if (name) {
          locationName = name;
          send({ type: "location", name });
        }
      })
      .catch(() => {
        /* non-fatal: loading screen just omits the sub-account name */
      });

    // Fetch pipelines, users, lost reasons, and custom field definitions first (fast, no pagination)
    const [pipelinesResult, usersResult, customFieldsResult, lostReasonsResult] =
      await Promise.allSettled([
        getPipelines(),
        getUsers(),
        getCustomFields(),
        getLostReasons(),
      ]);

    send({ type: "progress", message: "Cargando pipelines y configuración…" });

    const pipelinesRaw = pipelinesResult.status === "fulfilled" ? pipelinesResult.value : { pipelines: [] };
    const usersRaw = usersResult.status === "fulfilled" ? usersResult.value : { users: [] };
    const customFieldsRaw = customFieldsResult.status === "fulfilled" ? customFieldsResult.value : { customFields: [] };
    const lostReasonsRaw = lostReasonsResult.status === "fulfilled" ? lostReasonsResult.value : { lostReasons: [] };

    // Build custom field id→name lookup
    const customFieldMap = new Map<string, string>();
    for (const cf of customFieldsRaw.customFields) {
      customFieldMap.set(cf.id, cf.name);
    }

    // Build native lost-reason id→name lookup (empty for accounts without a catalog)
    const lostReasonMap = new Map<string, string>();
    for (const lr of lostReasonsRaw.lostReasons) {
      lostReasonMap.set(lr._id, lr.name);
    }

    // Build pipeline lookup map
    const pipelineMap = new Map<string, { name: string; stages: Map<string, string> }>();
    const pipelineList: Pipeline[] = [];

    for (const p of pipelinesRaw.pipelines) {
      const stageMap = new Map<string, string>();
      for (const s of p.stages) {
        stageMap.set(s.id, s.name);
      }
      pipelineMap.set(p.id, { name: p.name, stages: stageMap });
      pipelineList.push({
        id: p.id,
        name: p.name,
        stages: p.stages.map((s) => s.name),
      });
    }

    // Build user lookup map
    const userMap = new Map<string, string>();
    const members: string[] = [];
    for (const u of usersRaw.users) {
      const name = u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim();
      userMap.set(u.id, name);
      members.push(name);
    }
    sendStep("config", "done");

    // Contacts, opportunities, pautas, appointments and tasks are all
    // independent of one another — only the transforms afterward depend on
    // the lookup maps built above. Fetch them concurrently and let the
    // process-wide semaphore + token bucket in ghl-client pace the combined
    // GHL load (the old "fetch pautas last to avoid rate-limiting" ordering
    // is now handled centrally). Progress messages from contacts/opps
    // interleave — the intended tradeoff for the latency win.
    send({ type: "progress", message: "Cargando datos de Lezgo Suite CRM…" });
    for (const k of ["contacts", "opportunities", "pautas", "appointments", "tasks"]) {
      sendStep(k, "loading", 0);
    }

    const [contactsOut, opportunitiesOut, pautasOut, appointmentsOut, tasksOut] =
      await Promise.all([
        runDataset("contacts", send, (onProgress) =>
          getAllContacts((count) => {
            send({
              type: "progress",
              message: `Cargando contactos… ${count.toLocaleString("es-MX")}`,
            });
            onProgress(count);
          })
        ),
        runDataset("opportunities", send, (onProgress) =>
          getAllOpportunities((count) => {
            send({
              type: "progress",
              message: `Cargando oportunidades… ${count.toLocaleString("es-MX")}`,
            });
            onProgress(count);
          })
        ),
        runDataset("pautas", send, (onProgress) => fetchAllPautas(onProgress)),
        // fetchAppointments swallows its own errors and returns [], so a real
        // failure reads here as "zero appointments" and raises no warning.
        // Pre-existing behavior, left alone deliberately.
        runDataset("appointments", send, async () =>
          asPaged(await fetchAppointments(userMap))
        ),
        runDataset("tasks", send, async () => {
          const { tasks, truncated } = await searchLocationTasks();
          const records = tasks.map(transformTask);
          // `missingPages` no vacío es lo que hace que runDataset marque el
          // paso como "partial" y que la ruta emita el warning ámbar. No se
          // sabe CUÁNTAS faltan (el endpoint no reporta total), así que va
          // sin `total` y el banner omite el "de ~N".
          const cut = truncated.pending || truncated.completed;
          return {
            records,
            missingPages: cut ? [1] : [],
            missingEstimate: 0,
          };
        }),
      ]);

    const contactsRaw = contactsOut.records;
    const opportunitiesRaw = opportunitiesOut.records;
    const pautas = pautasOut.records;
    const appointments = appointmentsOut.records;
    const tasks = tasksOut.records;

    const warnings: SyncWarning[] = [
      contactsOut,
      opportunitiesOut,
      pautasOut,
      appointmentsOut,
      tasksOut,
    ]
      .filter((o) => o.status !== "done")
      .map((o) => ({
        key: o.key,
        kind: o.status as "partial" | "error",
        loaded: o.loaded,
        expected: o.expected,
      }));

    send({ type: "progress", message: "Procesando datos…" });

    // Transform contacts
    const contacts: Contact[] = contactsRaw.map((c) => {
      const contact = transformContact(c, customFieldMap);
      if (contact.assignedTo && userMap.has(contact.assignedTo)) {
        contact.assignedTo = userMap.get(contact.assignedTo);
      }
      return contact;
    });

    // Transform opportunities
    const opportunities: Opportunity[] = opportunitiesRaw.map((o) => {
      const opp = transformOpportunity(o, pipelineMap, customFieldMap, lostReasonMap);
      if (opp.assignedTo && userMap.has(opp.assignedTo)) {
        opp.assignedTo = userMap.get(opp.assignedTo);
      }
      return opp;
    });

    // Enrich opportunities with attribution from linked contact
    const contactById = new Map<string, Contact>();
    for (const c of contacts) {
      contactById.set(c.id, c);
    }

    // GHL guarantees every opportunity has a contact, and the
    // /opportunities/search response already embeds { id, name, email,
    // phone, tags }. The /contacts/ list endpoint, however, sometimes
    // omits records (archived, restricted, pagination quirks). For any
    // opp whose contact wasn't returned by /contacts/, synthesize a
    // Contact from the opportunity-embedded data so the UI always
    // resolves the lookup.
    let synthesizedCount = 0;
    for (const raw of opportunitiesRaw) {
      const embedded = raw.contact;
      if (!embedded?.id) continue;
      if (contactById.has(embedded.id)) continue;

      const attr = firstAttr(raw.attributions);
      const synth: Contact = {
        id: embedded.id,
        name:
          embedded.name?.trim() ||
          embedded.email ||
          embedded.phone ||
          "Sin nombre",
        email: embedded.email ?? "",
        phone: embedded.phone ?? "",
        tags: embedded.tags ?? [],
        dateAdded: raw.createdAt,
        createdAt: raw.createdAt,
        source: attr?.utmSource || attr?.adSource || raw.source || "direct",
        campaign: buildCampaignLabel(attr?.utmContent, attr?.utmCampaign),
        campaignName: attr?.utmCampaign || undefined,
        adType: attr?.utmMedium || attr?.utmSessionSource,
        adId: attr?.utmAdId || undefined,
        attributionUrl: attr?.url || undefined,
        attributionMedium: attr?.medium || attr?.utmSessionSource || undefined,
        assignedTo:
          raw.assignedTo && userMap.has(raw.assignedTo)
            ? userMap.get(raw.assignedTo)
            : raw.assignedTo,
      };
      contactById.set(embedded.id, synth);
      contacts.push(synth);
      synthesizedCount++;
    }
    if (synthesizedCount > 0) {
      console.warn(
        `[GHL] Synthesized ${synthesizedCount} contacts from opportunity-embedded data ` +
          `(missing from /contacts/ list of ${contactsRaw.length}).`
      );
    }

    for (const opp of opportunities) {
      const contact = contactById.get(opp.contactId);
      if (contact) {
        if (!opp.campaign) opp.campaign = contact.campaign;
        if (!opp.campaignName) opp.campaignName = contact.campaignName;
        if (!opp.adType) opp.adType = contact.adType;
        if (!opp.source) opp.source = contact.source;
        if (!opp.adId) opp.adId = contact.adId;
        if (!opp.attributionUrl) opp.attributionUrl = contact.attributionUrl;
        if (!opp.attributionMedium) opp.attributionMedium = contact.attributionMedium;
        // "Origen de Lead" is a contact-level custom field; surface it on the
        // opportunity as an explicit, high-confidence fallback for platformLabel.
        if (!opp.originPlatform) {
          opp.originPlatform = cfString(contact.customFieldsResolved?.["Origen de Lead"]);
        }
      }
    }

    // Conversations/messages are fetched separately by /api/dashboard-messages
    // (background load) so the expensive per-user message fan-out stays off
    // the critical path of the initial dashboard render.
    //
    // Appointments and tasks were already fetched concurrently above (see the
    // Promise.all). GHL exposes no public calls endpoint in the standard API.
    const calls: Call[] = [];

    // Extract unique tags, campaigns, sources
    const tagSet = new Set<string>();
    const campaignSet = new Set<string>();
    const sourceSet = new Set<string>();
    for (const c of contacts) {
      for (const t of c.tags) tagSet.add(t);
      if (c.campaign) campaignSet.add(c.campaign);
      if (c.source) sourceSet.add(c.source);
    }
    for (const o of opportunities) {
      if (o.campaign) campaignSet.add(o.campaign);
      if (o.source) sourceSet.add(o.source);
    }

    // Ensure the sub-account name is settled before the final payload.
    await locationPromise;

    return {
      locationName,
      contacts,
      opportunities,
      calls,
      tasks,
      appointments,
      pipelines: pipelineList,
      members,
      tags: Array.from(tagSet),
      campaigns: Array.from(campaignSet),
      sources: Array.from(sourceSet),
      pautas,
      locationId: client.locationId,
      warnings,
      meta: {
        totalContacts: contacts.length,
        totalOpportunities: opportunities.length,
        fetchedAt: new Date().toISOString(),
      },
    };
  });
}
