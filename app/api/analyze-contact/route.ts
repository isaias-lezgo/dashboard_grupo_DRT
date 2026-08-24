import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getOpportunityById } from "@/lib/ghl-client";
import { requireClient, unauthorized } from "@/lib/session";
import { withClient } from "@/lib/ghl-context";

// ─── Request types ────────────────────────────────────────────────────────────

// Accept the full GHL-shaped objects — no field is dropped client-side.
type ContactPayload = Record<string, unknown> & {
  name: string;
  email?: string;
  phone?: string;
};

type OpportunityPayload = Record<string, unknown> & {
  id: string;
  name: string;
  pipelineName: string;
  stage: string;
  status: string;
  value: number;
};

interface TaskPayload {
  title: string;
  type: string;
  status: string;
  dueDate?: string;
}

interface CallPayload {
  direction: string;
  status: string;
  durationSeconds: number;
  createdAt: string;
}

interface AppointmentPayload {
  title?: string;
  startTime: string;
  endTime?: string;
  status?: string;
  notes?: string;
}

interface MessagePayload {
  direction: "inbound" | "outbound";
  source?: string;
  content?: string;
  createdAt: string;
}

interface AnalyzeContactBody {
  opportunityId: string;
  contact: ContactPayload;
  opportunity: OpportunityPayload;
  tasks?: TaskPayload[];
  calls?: CallPayload[];
  // Provided by the client from already-loaded dashboard data. When present,
  // appointments are used as-is and the server skips the live GHL fetch.
  appointments?: AppointmentPayload[];
  // Recent conversation, chronological (oldest→newest).
  messages?: MessagePayload[];
  // IANA timezone from the user's browser. Falls back to America/Mexico_City.
  userTimezone?: string;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres un analista de ventas experto en CRM y GoHighLevel. Recibirás el perfil completo de un contacto/lead: información personal, oportunidad de venta, tareas, llamadas, citas y los mensajes recientes de la conversación. Genera un reporte conciso, accionable y en español.

Tu reporte debe seguir EXACTAMENTE este formato Markdown:

## Perfil del lead
Una o dos oraciones: quién es, de dónde vino (fuente/campaña), en qué etapa del pipeline está y quién lo atiende.

## Calidad del lead
Clasifica como **🔥 Hot**, **☀️ Warm**, o **❄️ Cold** y justifica en una oración. Considera: valor de la oportunidad, etapa del pipeline, fuente, tags, urgencia aparente y el tono/intención en la conversación reciente.

## Estado de la oportunidad
Pipeline, etapa actual, valor monetario, estado (open/won/lost/abandoned). Si está perdida, menciona la razón. Si está ganada, felicita brevemente.

## Citas programadas
Solo incluye esta sección si hay citas. Lista cada cita con: fecha, estado y notas si las hay. Si no hay citas, omite esta sección completamente.

## Tareas pendientes
Solo incluye esta sección si hay tareas con status "pending". Lista título, tipo y fecha de vencimiento. Si no hay tareas pendientes, omite esta sección completamente.

## Conversación reciente
Solo incluye esta sección si hay mensajes. En 1-2 oraciones: qué pidió el lead, qué respondió el asesor y si quedó algo pendiente o sin responder. Si no hay mensajes, omite esta sección completamente.

## Próximos pasos sugeridos
1. Acción concreta #1 — qué hacer, cuándo, cómo
2. Acción concreta #2
3. Acción concreta #3

## Señales de alerta
Solo incluye esta sección si detectas: oportunidad estancada sin actividad reciente, lead caliente sin citas agendadas, tareas vencidas, oportunidad de alto valor sin seguimiento, o el último mensaje es del lead y sigue sin respuesta (ghosting del asesor). Si todo está en orden, omite esta sección completamente.

Reglas:
- Sé directo y conciso. Nada de relleno corporativo.
- Usa el nombre del contacto cuando te refieras a él.
- Si los datos de llamadas y tareas están vacíos, trabaja con lo que tienes y menciónalo brevemente.
- Fechas en formato legible (dd/mm/yyyy).`;

// ─── Context serializer ───────────────────────────────────────────────────────

function formatDate(iso: string, tz = "America/Mexico_City"): string {
  try {
    return new Date(iso).toLocaleDateString("es-MX", { timeZone: tz });
  } catch {
    return iso;
  }
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  return String(v);
}

function buildContext(
  body: AnalyzeContactBody,
  calendarEvents: Array<{
    title?: string;
    startTime: string;
    endTime: string;
    appointmentStatus?: string;
    notes?: string;
  }>,
  tz = "America/Mexico_City"
): string {
  const { contact, opportunity, tasks = [], calls = [] } = body;
  const lines: string[] = [];

  lines.push("=== CONTACTO ===");
  lines.push(`Nombre: ${contact.name}`);
  if (contact.email) lines.push(`Email: ${contact.email}`);
  if (contact.phone) lines.push(`Teléfono: ${contact.phone}`);
  if (str(contact.companyName)) lines.push(`Empresa: ${contact.companyName}`);
  const location = [contact.city, contact.state, contact.country].filter(Boolean).join(", ");
  if (location) lines.push(`Ubicación: ${location}`);
  if (contact.timezone) lines.push(`Zona horaria: ${contact.timezone}`);
  if (contact.website) lines.push(`Sitio web: ${contact.website}`);
  if (contact.dateOfBirth) lines.push(`Fecha de nacimiento: ${formatDate(String(contact.dateOfBirth), tz)}`);
  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
  if (str(contact.source)) lines.push(`Fuente: ${contact.source}`);
  if (str(contact.campaign)) lines.push(`Campaña: ${contact.campaign}`);
  if (str(contact.adType)) lines.push(`Tipo de anuncio: ${contact.adType}`);
  if (str(contact.assignedTo)) lines.push(`Asignado a: ${contact.assignedTo}`);
  if (str(contact.lastActivity)) lines.push(`Última actividad: ${formatDate(String(contact.lastActivity), tz)}`);
  if (contact.dnd) lines.push(`DND: sí`);
  if (str(contact.dateAdded)) lines.push(`Creado: ${formatDate(String(contact.dateAdded), tz)}`);
  const contactCustomFields = contact.customFieldsResolved as Record<string, string | string[]> | undefined;
  if (contactCustomFields && Object.keys(contactCustomFields).length > 0) {
    lines.push("Campos personalizados:");
    for (const [name, value] of Object.entries(contactCustomFields)) {
      lines.push(`  ${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
  }

  lines.push("\n=== OPORTUNIDAD ===");
  lines.push(`Nombre: ${opportunity.name}`);
  lines.push(`Pipeline: ${opportunity.pipelineName}`);
  lines.push(`Etapa: ${opportunity.stage}`);
  lines.push(`Estado: ${opportunity.status}`);
  lines.push(`Valor: $${opportunity.value.toLocaleString("es-MX")}${opportunity.currency ? ` ${opportunity.currency}` : ""}`);
  if (opportunity.probability !== undefined && opportunity.probability !== null) {
    lines.push(`Probabilidad: ${opportunity.probability}%`);
  }
  if (str(opportunity.priority)) lines.push(`Prioridad: ${opportunity.priority}`);
  if (str(opportunity.lostReason)) lines.push(`Razón de pérdida: ${opportunity.lostReason}`);
  if (str(opportunity.assignedTo)) lines.push(`Asignado a: ${opportunity.assignedTo}`);
  if (str(opportunity.notes)) lines.push(`Notas: ${opportunity.notes}`);
  if (str(opportunity.origin)) lines.push(`Origen: ${opportunity.origin}`);
  if (opportunity.archived) lines.push(`Archivada: sí`);
  lines.push(`Creada: ${formatDate(String(opportunity.createdAt), tz)}`);
  if (str(opportunity.updatedAt)) lines.push(`Última actualización: ${formatDate(String(opportunity.updatedAt), tz)}`);
  if (str(opportunity.closedAt)) lines.push(`Fecha de cierre: ${formatDate(String(opportunity.closedAt), tz)}`);
  if (str(opportunity.lastActivity)) lines.push(`Última actividad: ${formatDate(String(opportunity.lastActivity), tz)}`);
  const oppCustomFields = opportunity.customFieldsResolved as Record<string, string | string[]> | undefined;
  if (oppCustomFields && Object.keys(oppCustomFields).length > 0) {
    lines.push("Campos personalizados:");
    for (const [name, value] of Object.entries(oppCustomFields)) {
      lines.push(`  ${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
  }

  if (calendarEvents.length > 0) {
    lines.push("\n=== CITAS ===");
    for (const ev of calendarEvents) {
      const start = formatDate(ev.startTime, tz);
      const status = ev.appointmentStatus ?? "sin estado";
      const title = ev.title ?? "Cita";
      lines.push(
        `- ${title} | ${start} | Estado: ${status}${ev.notes ? ` | Notas: ${ev.notes}` : ""}`
      );
    }
  } else {
    lines.push("\n=== CITAS ===\n(Sin citas registradas)");
  }

  if (tasks.length > 0) {
    lines.push("\n=== TAREAS ===");
    for (const t of tasks) {
      const due = t.dueDate ? formatDate(t.dueDate, tz) : "sin fecha";
      lines.push(`- [${t.status.toUpperCase()}] ${t.title} | Tipo: ${t.type} | Vence: ${due}`);
    }
  } else {
    lines.push("\n=== TAREAS ===\n(Sin tareas registradas)");
  }

  if (calls.length > 0) {
    lines.push("\n=== LLAMADAS ===");
    for (const c of calls) {
      const mins = Math.floor(c.durationSeconds / 60);
      const secs = c.durationSeconds % 60;
      const dur =
        c.status === "completed"
          ? `${mins}:${String(secs).padStart(2, "0")}`
          : "no contestada";
      lines.push(`- ${formatDate(c.createdAt, tz)} | ${c.direction} | ${c.status} | ${dur}`);
    }
  } else {
    lines.push("\n=== LLAMADAS ===\n(Sin llamadas registradas)");
  }

  const messages = body.messages ?? [];
  if (messages.length > 0) {
    lines.push("\n=== CONVERSACIÓN RECIENTE (más antiguo → más reciente) ===");
    for (const m of messages) {
      const when = (() => {
        try {
          return new Date(m.createdAt).toLocaleString("es-MX", { timeZone: tz });
        } catch {
          return m.createdAt;
        }
      })();
      const speaker = m.direction === "inbound" ? contact.name : "Asesor";
      const src = m.source ? ` (${m.source})` : "";
      const content = (m.content ?? "").length > 500 ? `${(m.content ?? "").slice(0, 500)}…` : m.content ?? "";
      lines.push(`[${when}]${src} ${speaker}: ${content}`);
    }
  }

  return lines.join("\n");
}

// ─── Route handler ────────────────────────────────────────────────────────────

export const runtime = "nodejs";

export async function POST(req: Request) {
  const client = await requireClient();
  if (!client) return unauthorized();

  return withClient(client, async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY no está configurada en el servidor" },
        { status: 500 }
      );
    }

    let body: AnalyzeContactBody;
    try {
      body = (await req.json()) as AnalyzeContactBody;
    } catch {
      return NextResponse.json({ error: "Cuerpo de petición inválido" }, { status: 400 });
    }

    if (!body.opportunityId || !body.contact?.name || !body.opportunity?.id || !body.opportunity?.pipelineName) {
      return NextResponse.json(
        { error: "Faltan campos requeridos: opportunityId, contact.name, opportunity.id" },
        { status: 400 }
      );
    }

    // Prefer the appointments the client already loaded; only fall back to a
    // live GHL fetch when the client sent none (avoids a redundant round-trip).
    let calendarEvents: Array<{
      title?: string;
      startTime: string;
      endTime: string;
      appointmentStatus?: string;
      notes?: string;
    }> = [];
    if (Array.isArray(body.appointments) && body.appointments.length > 0) {
      calendarEvents = body.appointments.map((a) => ({
        title: a.title,
        startTime: a.startTime,
        endTime: a.endTime ?? a.startTime,
        appointmentStatus: a.status,
        notes: a.notes,
      }));
    } else {
      try {
        const oppDetail = await getOpportunityById(body.opportunityId);
        calendarEvents = oppDetail.calendarEvents ?? [];
      } catch (err) {
        console.warn("[analyze-contact] Could not fetch opportunity detail for calendar events:", err);
      }
    }

    const tz = body.userTimezone ?? "America/Mexico_City";
    const contextText = buildContext(body, calendarEvents, tz);
    const client = new Anthropic();

    try {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: `Analiza el siguiente perfil de contacto del CRM:\n\n${contextText}`,
          },
        ],
      });

      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text"
      );

      return NextResponse.json({
        analysis: textBlock?.text ?? "No se pudo generar el análisis.",
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        return NextResponse.json({ error: "API key de Anthropic inválida" }, { status: 500 });
      }
      if (error instanceof Anthropic.RateLimitError) {
        return NextResponse.json(
          { error: "Límite de tasa alcanzado, intenta de nuevo en un momento" },
          { status: 429 }
        );
      }
      if (error instanceof Anthropic.APIError) {
        console.error("[analyze-contact] Anthropic API error:", error.status, error.message);
        return NextResponse.json(
          { error: `Error de Anthropic API: ${error.message}` },
          { status: 502 }
        );
      }
      console.error("[analyze-contact] Unknown error:", error);
      return NextResponse.json(
        { error: "Error desconocido al generar el análisis" },
        { status: 500 }
      );
    }
  });
}
