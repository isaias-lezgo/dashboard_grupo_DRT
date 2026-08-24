// Builds the CSV for the chart drill drawer's "Exportar" button. The drawer
// renders one of five content modes (members / contacts / pautas / tasks /
// opportunities); this mirrors that same selection so the exported file matches
// exactly what the drawer is showing. Joins resolve against the drawer's own
// props (contacts lookup), the same data the UI renders from.

import type { Contact, Opportunity } from "@/lib/types"
import type { DrillState } from "@/components/dashboard/chart-drill-drawer"
import { buildCsv } from "@/lib/csv"
import { isWonOpp } from "@/lib/opportunity-status"
import { pautaContactName, pautaContactPhone } from "@/lib/pauta"

export interface DrillExport {
  filename: string
  csvContent: string
  rowCount: number
}

// Turn a drill title into a filesystem-friendly slug for the filename.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}

const latestOppFor = (contactId: string, opps: Opportunity[]): Opportunity | undefined =>
  opps
    .filter((o) => o.contactId === contactId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]

/**
 * Returns the CSV for whatever the drawer is currently showing, or null when
 * there is nothing to export. `contacts` is the drawer's contacts prop, used to
 * resolve names for the opportunities mode.
 */
export function buildDrillExport(drill: DrillState, contacts: Contact[]): DrillExport | null {
  const today = new Date().toISOString().slice(0, 10)
  const slug = slugify(drill.title) || "registros"

  const showMembers = (drill.members?.length ?? 0) > 0
  const showContacts = !showMembers && (drill.contactItems?.length ?? 0) > 0
  const showPautas = !showMembers && !showContacts && (drill.pautaItems?.length ?? 0) > 0
  const showTasks =
    !showMembers && !showContacts && !showPautas && (drill.taskItems?.length ?? 0) > 0

  let mode: string
  let headers: string[]
  let rows: Array<Record<string, unknown>>

  if (showMembers) {
    mode = "vendedores"
    headers = ["vendedor", "totalOpps", "ganadas", "ingresos"]
    const opps = drill.opportunities
    rows = drill
      .members!.map((member) => {
        const mine = opps.filter((o) => o.assignedTo === member)
        const won = mine.filter(isWonOpp)
        return {
          vendedor: member,
          totalOpps: mine.length,
          ganadas: won.length,
          ingresos: won.reduce((s, o) => s + o.value, 0),
        }
      })
      .sort((a, b) => (b.totalOpps as number) - (a.totalOpps as number))
  } else if (showContacts) {
    mode = "contactos"
    headers = [
      "nombre", "email", "telefono", "empresa", "ciudad", "estado",
      "fuente", "campana", "asignado", "tags", "creado",
    ]
    rows = drill.contactItems!.map((c) => ({
      nombre: c.name,
      email: c.email ?? "",
      telefono: c.phone ?? "",
      empresa: c.companyName ?? "",
      ciudad: c.city ?? "",
      estado: c.state ?? "",
      fuente: c.source ?? "",
      campana: c.campaign ?? "",
      asignado: c.assignedTo ?? "",
      tags: (c.tags ?? []).join("|"),
      creado: c.createdAt,
    }))
  } else if (showPautas) {
    mode = "pautas"
    headers = [
      "nombre", "telefono", "tipo", "nombrePauta", "tieneContacto", "creado",
    ]
    rows = drill.pautaItems!.map(({ pauta, contact }) => ({
      nombre: contact?.name ?? pautaContactName(pauta) ?? "",
      telefono: contact?.phone ?? pautaContactPhone(pauta) ?? "",
      tipo: pauta.tipo ?? "",
      nombrePauta: pauta.nombrePauta ?? "",
      tieneContacto: contact ? "sí" : "no",
      creado: pauta.createdAt ?? "",
    }))
  } else if (showTasks) {
    mode = "tareas"
    headers = ["tarea", "contacto", "asignado", "vence", "estatus", "detalle"]
    rows = drill.taskItems!.map((t) => {
      const contact = t.contactId ? contacts.find((c) => c.id === t.contactId) : undefined
      return {
        tarea: t.title ?? "",
        // Vacío cuando la tarea no trae contacto — es un dato ausente, no un
        // nombre que el CSV deba inventar.
        contacto: contact?.name ?? t.contactName ?? "",
        asignado: t.assignedToName ?? "",
        vence: t.dueDate ?? "",
        estatus: t.status,
        detalle: t.body ?? "",
      }
    })
  } else {
    mode = "oportunidades"
    headers = [
      "contacto", "oportunidad", "pipeline", "etapa", "status", "valor",
      "asignado", "campana", "fuente", "medio", "motivoPerdido", "creado",
    ]
    rows = drill.opportunities.map((o) => {
      const contact = contacts.find((c) => c.id === o.contactId)
      return {
        contacto: contact?.name ?? "",
        oportunidad: o.name,
        pipeline: o.pipelineName ?? "",
        etapa: o.stage ?? "",
        status: o.status,
        valor: o.value,
        asignado: o.assignedTo ?? "",
        campana: o.campaign ?? "",
        fuente: o.source ?? "",
        medio: o.attributionMedium ?? "",
        motivoPerdido: o.lostReason ?? "",
        creado: o.createdAt,
      }
    })
  }

  if (rows.length === 0) return null

  // Avoid "oportunidades-oportunidades-…" when the drill title is just the mode
  // (e.g. the summary KPI cards). Chart-row drills carry a distinct title.
  const namePart = slug === mode ? mode : `${mode}-${slug}`

  return {
    filename: `${namePart}-${today}.csv`,
    csvContent: buildCsv(headers, rows),
    rowCount: rows.length,
  }
}
