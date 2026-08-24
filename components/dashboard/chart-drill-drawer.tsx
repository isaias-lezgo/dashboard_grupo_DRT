"use client"

import { useState } from "react"
import { motion } from "framer-motion"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { DetailDrawer } from "./detail-drawer"
import type { Opportunity, Contact, Task, Call, Pauta, Appointment, Message } from "@/lib/types"
import { isWonOpp } from "@/lib/opportunity-status"
import { pautaContactName, pautaContactPhone } from "@/lib/pauta"
import { buildDrillExport } from "@/lib/drill-export"
import { triggerDownload } from "@/lib/download"
import { cn } from "@/lib/utils"
import { MISSING_TEXT } from "./dashboard-ui"
import { PANEL_TIME_ZONE } from "@/lib/task-backlog"
import { DollarSign, User, Tag, ChevronRight, TrendingUp, Phone, Mail, Download, ListChecks } from "lucide-react"

const STAGE_CLASSES: Record<string, string> = {
  "Primera Cita":            "bg-blue-100 text-blue-700",
  "Segunda Cita":            "bg-purple-100 text-purple-700",
  "Envío de propuesta":      "bg-amber-100 text-amber-700",
  "Envío de liga de pago":   "bg-cyan-100 text-cyan-700",
  "Proceso de Implementación":"bg-emerald-100 text-emerald-700",
  "Cliente Activo":          "bg-green-100 text-green-700",
  "Servicio Terminado":      "bg-gray-100 text-gray-600",
  "Prospecto Perdido":       "bg-red-100 text-red-700",
  Discovery:                 "bg-blue-100 text-blue-700",
  Proposal:                  "bg-purple-100 text-purple-700",
  Negotiation:               "bg-amber-100 text-amber-700",
  "Closed Won":              "bg-emerald-100 text-emerald-700",
  "Closed Lost":             "bg-red-100 text-red-700",
}

const STATUS_STYLES: Record<string, string> = {
  open:      "bg-blue-50 text-blue-700 border-blue-200",
  won:       "bg-emerald-50 text-emerald-700 border-emerald-200",
  lost:      "bg-red-50 text-red-700 border-red-200",
  abandoned: "bg-gray-50 text-gray-600 border-gray-200",
}

export interface DrillState {
  open: boolean
  title: string
  subtitle?: string
  opportunities: Opportunity[]
  members?: string[]
  contactItems?: Contact[]
  /**
   * One entry per pauta RECORD (contacts may repeat, and `contact` is undefined
   * when the pauta has no resolvable contact). Used by the "Pautas por canal"
   * drill in records mode so the drawer count matches the chart's pauta-record
   * count exactly — deduping to contacts (contactItems) would drop repeats and
   * contact-less pautas, which is the unique-leads behaviour instead.
   */
  pautaItems?: { pauta: Pauta; contact?: Contact }[]
  /**
   * One entry per TASK. Used where the chart counts tasks rather than the
   * contacts behind them — deduping to `contactItems` is wrong there, because a
   * task can carry no `contactId` at all (GHL allows it) and would vanish from
   * a drill whose count said it was there.
   */
  taskItems?: Task[]
}

export const DRILL_CLOSED: DrillState = { open: false, title: "", opportunities: [] }

interface ChartDrillDrawerProps {
  drill: DrillState
  onDrillChange: (d: DrillState) => void
  contacts: Contact[]
  tasks: Task[]
  calls: Call[]
  /** Full opportunity list needed by DetailDrawer to resolve the selected ID */
  allOpportunities: Opportunity[]
  allPautas?: Pauta[]
  appointments?: Appointment[]
  messages?: Message[]
  locationId?: string
}

export function ChartDrillDrawer({
  drill,
  onDrillChange,
  contacts,
  tasks,
  calls,
  allOpportunities,
  allPautas = [],
  appointments = [],
  messages = [],
  locationId = "",
}: ChartDrillDrawerProps) {
  const [selectedOppId, setSelectedOppId] = useState<string | null>(null)
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const showMembers = (drill.members?.length ?? 0) > 0
  const showContacts = !showMembers && (drill.contactItems?.length ?? 0) > 0
  const showPautas = !showMembers && !showContacts && (drill.pautaItems?.length ?? 0) > 0
  const showTasks =
    !showMembers && !showContacts && !showPautas && (drill.taskItems?.length ?? 0) > 0
  const count = showMembers
    ? (drill.members?.length ?? 0)
    : showContacts
      ? (drill.contactItems?.length ?? 0)
      : showPautas
        ? (drill.pautaItems?.length ?? 0)
        : showTasks
          ? (drill.taskItems?.length ?? 0)
          : drill.opportunities.length

  const handleExport = () => {
    const result = buildDrillExport(drill, contacts)
    if (!result) return
    triggerDownload({
      content: "﻿" + result.csvContent, // BOM so Excel reads UTF-8 (acentos)
      filename: result.filename,
      mimeType: "text/csv;charset=utf-8",
    })
  }

  return (
    <>
      <Sheet open={drill.open} onOpenChange={(o) => onDrillChange({ ...drill, open: o })}>
        <SheetContent className="w-[500px] sm:max-w-[500px] p-0 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="border-b border-border px-6 pt-5 pb-4 flex-none">
            <SheetHeader>
              <SheetTitle className="text-[15px] font-semibold leading-snug pr-6">
                {drill.title}
              </SheetTitle>
            </SheetHeader>
            {/* Siempre montada: Radix exige una descripción ligada al SheetContent */}
            <SheetDescription
              className={
                drill.subtitle ? "text-xs text-muted-foreground mt-0.5" : "sr-only"
              }
            >
              {drill.subtitle ?? "Detalle de los registros del segmento seleccionado."}
            </SheetDescription>
            <div className="mt-2.5 flex items-center justify-between gap-2">
              <Badge variant="secondary" className="rounded-full text-xs font-semibold tabular-nums">
                {count.toLocaleString()} registro{count !== 1 ? "s" : ""}
              </Badge>
              <button
                type="button"
                onClick={handleExport}
                disabled={count === 0}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" />
                Exportar
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
            {showMembers ? (
              <MembersList members={drill.members!} opportunities={drill.opportunities} />
            ) : showContacts ? (
              <ContactList
                contacts={drill.contactItems!}
                allOpportunities={allOpportunities}
                onSelectOpp={(id) => { setSelectedOppId(id); setSelectedContactId(null); setDetailOpen(true) }}
                onSelectContact={(id) => { setSelectedContactId(id); setSelectedOppId(null); setDetailOpen(true) }}
              />
            ) : showPautas ? (
              <PautaList
                items={drill.pautaItems!}
                allOpportunities={allOpportunities}
                onSelectOpp={(id) => { setSelectedOppId(id); setSelectedContactId(null); setDetailOpen(true) }}
                onSelectContact={(id) => { setSelectedContactId(id); setSelectedOppId(null); setDetailOpen(true) }}
              />
            ) : showTasks ? (
              <TaskList
                items={drill.taskItems!}
                contacts={contacts}
                onSelectContact={(id) => { setSelectedContactId(id); setSelectedOppId(null); setDetailOpen(true) }}
              />
            ) : count === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                Sin datos para mostrar.
              </div>
            ) : (
              drill.opportunities.map((opp, i) => {
                const contact = contacts.find((c) => c.id === opp.contactId)
                return (
                  <motion.button
                    key={opp.id}
                    type="button"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.025, 0.4), duration: 0.18 }}
                    onClick={() => { setSelectedOppId(opp.id); setDetailOpen(true) }}
                    className="group w-full text-left rounded-xl border border-border bg-card p-4 hover:border-primary/40 hover:bg-accent/30 transition-all"
                  >
                    {/* Top row */}
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                          {contact?.name ?? "Contacto desconocido"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Badge variant="outline" className={`text-[10px] ${STATUS_STYLES[opp.status] ?? ""}`}>
                          {opp.status}
                        </Badge>
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </div>

                    {/* Opp name */}
                    <p className="text-xs text-muted-foreground mb-2.5 truncate pl-5">{opp.name}</p>

                    {/* Stage + value */}
                    <div className="flex items-center justify-between gap-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STAGE_CLASSES[opp.stage] ?? "bg-muted text-muted-foreground"}`}>
                        {opp.stage}
                      </span>
                      <div className="flex items-center gap-0.5 text-xs font-semibold text-foreground">
                        <DollarSign className="h-3 w-3 text-muted-foreground" />
                        {opp.value.toLocaleString("es-MX")}
                      </div>
                    </div>

                    {/* Meta */}
                    <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground pl-0.5">
                      {opp.assignedTo && (
                        <span className="flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {opp.assignedTo}
                        </span>
                      )}
                      {opp.campaign && (
                        <span className="flex items-center gap-1 truncate">
                          <Tag className="h-3 w-3 shrink-0" />
                          <span className="truncate">{opp.campaign}</span>
                        </span>
                      )}
                    </div>
                  </motion.button>
                )
              })
            )}
          </div>
        </SheetContent>
      </Sheet>

      <DetailDrawer
        open={detailOpen}
        onOpenChange={setDetailOpen}
        opportunityId={selectedOppId}
        contactId={selectedContactId}
        opportunities={allOpportunities}
        contacts={contacts}
        tasks={tasks}
        calls={calls}
        appointments={appointments}
        messages={messages}
        pautas={allPautas}
        locationId={locationId}
      />
    </>
  )
}

function ContactList({
  contacts,
  allOpportunities,
  onSelectOpp,
  onSelectContact,
}: {
  contacts: Contact[]
  allOpportunities: Opportunity[]
  onSelectOpp: (id: string) => void
  onSelectContact: (id: string) => void
}) {
  return (
    <>
      {contacts.map((c, i) => {
        const opp = allOpportunities
          .filter((o) => o.contactId === c.id)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]

        return (
          <motion.button
            key={c.id}
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.025, 0.4), duration: 0.18 }}
            onClick={() => opp ? onSelectOpp(opp.id) : onSelectContact(c.id)}
            className="group w-full text-left rounded-xl border border-border bg-card p-4 transition-all cursor-pointer hover:border-primary/40 hover:bg-accent/30"
          >
            {/* Top row */}
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                  {c.name}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {opp && (
                  <Badge variant="outline" className={`text-[10px] ${STATUS_STYLES[opp.status] ?? ""}`}>
                    {opp.status}
                  </Badge>
                )}
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>

            {/* Email */}
            <p
              className={cn(
                "text-xs mb-2.5 truncate pl-5",
                c.email || c.phone ? "text-muted-foreground" : MISSING_TEXT
              )}
            >
              {c.email || c.phone || "Sin datos de contacto"}
            </p>

            {/* Stage (from opp) + phone */}
            <div className="flex items-center justify-between gap-2">
              {opp ? (
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STAGE_CLASSES[opp.stage] ?? "bg-muted text-muted-foreground"}`}>
                  {opp.stage}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
                  Sin oportunidad
                </span>
              )}
              {opp && opp.value > 0 && (
                <div className="flex items-center gap-0.5 text-xs font-semibold text-foreground">
                  <DollarSign className="h-3 w-3 text-muted-foreground" />
                  {opp.value.toLocaleString("es-MX")}
                </div>
              )}
            </div>

            {/* Meta */}
            <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground pl-0.5">
              {(opp?.assignedTo ?? c.assignedTo) && (
                <span className="flex items-center gap-1">
                  <User className="h-3 w-3" />
                  {opp?.assignedTo ?? c.assignedTo}
                </span>
              )}
              {c.phone && c.email && (
                <span className="flex items-center gap-1 truncate">
                  <Phone className="h-3 w-3 shrink-0" />{c.phone}
                </span>
              )}
              {(opp?.campaign ?? c.campaign) && (
                <span className="flex items-center gap-1 truncate">
                  <Tag className="h-3 w-3 shrink-0" />
                  <span className="truncate">{opp?.campaign ?? c.campaign}</span>
                </span>
              )}
            </div>
          </motion.button>
        )
      })}
    </>
  )
}

/**
 * Lista de TAREAS. A diferencia de ContactList, una fila no siempre lleva a
 * ningún lado: GHL permite una tarea sin `contactId`, y esa fila se pinta como
 * texto plano en vez de botón — un botón que no navega miente sobre lo que hay
 * detrás. Ver `MISSING_TEXT` para la regla del rojizo en los huecos de captura.
 */
function TaskList({
  items,
  contacts,
  onSelectContact,
}: {
  items: Task[]
  contacts: Contact[]
  onSelectContact: (id: string) => void
}) {
  const fmtDue = (iso?: string) => {
    if (!iso) return null
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    return d.toLocaleDateString("es-MX", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: PANEL_TIME_ZONE,
    })
  }

  return (
    <>
      {items.map((t, i) => {
        const contact = t.contactId ? contacts.find((c) => c.id === t.contactId) : undefined
        const name = contact?.name ?? t.contactName
        const due = fmtDue(t.dueDate)
        const overdue = t.dueDate ? new Date(t.dueDate).getTime() < Date.now() : false

        const body = (
          <>
            {/* Top row: el título de la tarea es el dato principal aquí */}
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span
                  className={cn(
                    "text-sm font-semibold truncate",
                    name && "group-hover:text-primary transition-colors",
                    t.title ? "text-foreground" : MISSING_TEXT
                  )}
                >
                  {t.title || "Sin título"}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px]",
                    overdue
                      ? "bg-red-50 text-red-700 border-red-200"
                      : "bg-blue-50 text-blue-700 border-blue-200"
                  )}
                >
                  {overdue ? "Vencida" : "Pendiente"}
                </Badge>
                {name && (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
              </div>
            </div>

            {/* Contacto — la cubeta centinela cuando la tarea no trae ninguno */}
            <p className={cn("text-xs mb-2.5 truncate pl-5", name ? "text-muted-foreground" : MISSING_TEXT)}>
              {name ?? "Sin contacto"}
            </p>

            <div className="flex items-center justify-between gap-2">
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                  due ? "bg-muted text-muted-foreground" : cn("bg-muted", MISSING_TEXT)
                )}
              >
                {due ?? "Sin fecha"}
              </span>
              <span
                className={cn(
                  "truncate text-[11px]",
                  t.assignedToName ? "text-muted-foreground" : MISSING_TEXT
                )}
              >
                {t.assignedToName ?? "Sin asesor"}
              </span>
            </div>
          </>
        )

        const className =
          "group w-full text-left rounded-xl border border-border bg-card p-4 transition-all"

        // Sin contacto no hay detalle que abrir: fila estática, no botón.
        return name ? (
          <motion.button
            key={t.id}
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.025, 0.4), duration: 0.18 }}
            onClick={() => contact && onSelectContact(contact.id)}
            disabled={!contact}
            className={cn(
              className,
              contact && "cursor-pointer hover:border-primary/40 hover:bg-accent/30"
            )}
          >
            {body}
          </motion.button>
        ) : (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.025, 0.4), duration: 0.18 }}
            className={className}
          >
            {body}
          </motion.div>
        )
      })}
    </>
  )
}

function PautaList({
  items,
  allOpportunities,
  onSelectOpp,
  onSelectContact,
}: {
  items: { pauta: Pauta; contact?: Contact }[]
  allOpportunities: Opportunity[]
  onSelectOpp: (id: string) => void
  onSelectContact: (id: string) => void
}) {
  return (
    <>
      {items.map(({ pauta, contact }, i) => {
        // No resolvable contact: still render the record so the drawer count
        // matches the chart's pauta-record count. Nothing to drill into.
        if (!contact) {
          // No lead to drill into, but the pauta itself recorded the name and phone
          // at capture time — show them so the person is still reachable and the
          // broken record is identifiable in GHL for cleanup.
          const nombre = pautaContactName(pauta)
          const telefono = pautaContactPhone(pauta)
          return (
            <motion.div
              key={pauta.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.025, 0.4), duration: 0.18 }}
              className="w-full rounded-xl border border-dashed border-border bg-card/50 p-4"
            >
              <div className="flex items-center gap-1.5 min-w-0 mb-1.5">
                <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className={`text-sm font-semibold truncate ${nombre ? "text-foreground" : "text-muted-foreground"}`}>
                  {nombre ?? "Sin nombre"}
                </span>
                <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                  sin contacto
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate pl-5">
                {[
                  telefono,
                  pauta.tipo,
                  pauta.createdAt ? new Date(pauta.createdAt).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" }) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </motion.div>
          )
        }

        const opp = allOpportunities
          .filter((o) => o.contactId === contact.id)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]

        return (
          <motion.button
            key={pauta.id}
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.025, 0.4), duration: 0.18 }}
            onClick={() => opp ? onSelectOpp(opp.id) : onSelectContact(contact.id)}
            className="group w-full text-left rounded-xl border border-border bg-card p-4 transition-all cursor-pointer hover:border-primary/40 hover:bg-accent/30"
          >
            {/* Top row */}
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                  {contact.name}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {opp && (
                  <Badge variant="outline" className={`text-[10px] ${STATUS_STYLES[opp.status] ?? ""}`}>
                    {opp.status}
                  </Badge>
                )}
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>

            {/* Email */}
            <p
              className={cn(
                "text-xs mb-2.5 truncate pl-5",
                contact.email || contact.phone ? "text-muted-foreground" : MISSING_TEXT
              )}
            >
              {contact.email || contact.phone || "Sin datos de contacto"}
            </p>

            {/* Stage (from opp) + value */}
            <div className="flex items-center justify-between gap-2">
              {opp ? (
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STAGE_CLASSES[opp.stage] ?? "bg-muted text-muted-foreground"}`}>
                  {opp.stage}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
                  Sin oportunidad
                </span>
              )}
              {opp && opp.value > 0 && (
                <div className="flex items-center gap-0.5 text-xs font-semibold text-foreground">
                  <DollarSign className="h-3 w-3 text-muted-foreground" />
                  {opp.value.toLocaleString("es-MX")}
                </div>
              )}
            </div>
          </motion.button>
        )
      })}
    </>
  )
}

function MembersList({ members, opportunities }: { members: string[]; opportunities: Opportunity[] }) {
  const stats = members.map((member) => {
    const opps = opportunities.filter((o) => o.assignedTo === member)
    const won = opps.filter(isWonOpp).length
    const revenue = opps.filter(isWonOpp).reduce((s, o) => s + o.value, 0)
    return { member, total: opps.length, won, revenue }
  }).sort((a, b) => b.total - a.total)

  return (
    <>
      {stats.map((s, i) => (
        <motion.div
          key={s.member}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i * 0.04, 0.5), duration: 0.18 }}
          className="rounded-xl border border-border bg-card px-4 py-3 flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <User className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground truncate">{s.member}</span>
          </div>
          <div className="flex items-center gap-4 shrink-0 text-xs text-muted-foreground">
            <span className="tabular-nums">{s.total} opps</span>
            <span className="flex items-center gap-1 text-emerald-600 font-medium tabular-nums">
              <TrendingUp className="h-3 w-3" />{s.won} ganadas
            </span>
            {s.revenue > 0 && (
              <span className="flex items-center gap-0.5 font-semibold text-foreground tabular-nums">
                <DollarSign className="h-3 w-3 text-muted-foreground" />
                {s.revenue.toLocaleString("es-MX")}
              </span>
            )}
          </div>
        </motion.div>
      ))}
    </>
  )
}

