"use client"

import { useState } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import type { Opportunity, Contact, Task, Call, Appointment, Message, Pauta } from "@/lib/types"
import {
  Phone,
  Clock,
  Mail,
  MessageSquare,
  Calendar,
  DollarSign,
  User,
  ExternalLink,
  CalendarCheck,
  CalendarX,
  CalendarClock,
  ArrowDownLeft,
  ArrowUpRight,
  Smartphone,
  Facebook,
  Instagram,
  Globe,
  FileText,
  Tag,
  MapPin,
  Video,
  GitBranch,
  Megaphone,
  UserPlus,
} from "lucide-react"

interface DetailDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  opportunityId: string | null
  contactId?: string | null
  opportunities: Opportunity[]
  contacts: Contact[]
  tasks: Task[]
  calls: Call[]
  appointments?: Appointment[]
  messages?: Message[]
  pautas?: Pauta[]
  locationId?: string
}

// Semantic tag overrides for known CRM tags
const SEMANTIC_TAG_STYLES: Record<string, string> = {
  "no show": "bg-red-50 text-red-700 border-red-200",
  "noshow": "bg-red-50 text-red-700 border-red-200",
  "stop bot": "bg-orange-50 text-orange-700 border-orange-200",
  "Hot Lead": "bg-amber-50 text-amber-700 border-amber-200",
  "Warm Lead": "bg-amber-50/60 text-amber-600 border-amber-100",
  "Cold Lead": "bg-[#EAEDF1] text-[#151B28] border-border",
  "won": "bg-emerald-50 text-emerald-700 border-emerald-200",
  "Referral": "bg-emerald-50 text-emerald-700 border-emerald-200",
}

function getTagStyle(tag: string): string {
  const lower = tag.toLowerCase()
  for (const [key, style] of Object.entries(SEMANTIC_TAG_STYLES)) {
    if (lower === key.toLowerCase()) return style
  }
  return "bg-[#EAEDF1] text-[#151B28] border-border"
}

const STATUS_STYLES: Record<string, { badge: string; label: string }> = {
  open: {
    badge: "bg-[#FEF3C7] text-[#92400E] border-[#FCD34D]",
    label: "abierto",
  },
  won: {
    badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
    label: "ganado",
  },
  lost: {
    badge: "bg-red-50 text-red-600 border-red-200",
    label: "perdido",
  },
  abandoned: {
    badge: "bg-[#EAEDF1] text-[#151B28] border-border",
    label: "abandonado",
  },
}

const CHANNEL_LABELS: Record<string, string> = {
  sms: "SMS",
  email: "Email",
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  google_chat: "Google Chat",
  call: "Llamada",
  webchat: "Web Chat",
  live_chat: "Live Chat",
  tiktok: "TikTok",
  other: "Otro",
}

function ChannelIcon({ source }: { source: string }) {
  const cls = "h-3 w-3"
  if (source === "whatsapp" || source === "sms") return <Smartphone className={cls} />
  if (source === "email") return <Mail className={cls} />
  if (source === "facebook") return <Facebook className={cls} />
  if (source === "instagram") return <Instagram className={cls} />
  if (source === "call") return <Phone className={cls} />
  return <Globe className={cls} />
}

function formatCurrency(value: number): string {
  return `$${value.toLocaleString("es-MX")}`
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return "ahora"
  if (diffMins < 60) return `hace ${diffMins} min`
  const diffHrs = Math.floor(diffMins / 60)
  if (diffHrs < 24) return `hace ${diffHrs}h`
  const diffDays = Math.floor(diffHrs / 24)
  if (diffDays < 7) return `hace ${diffDays}d`
  return date.toLocaleDateString("es-MX", { day: "2-digit", month: "short" })
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
      {children}
    </p>
  )
}

export function DetailDrawer({
  open,
  onOpenChange,
  opportunityId,
  contactId,
  opportunities,
  contacts,
  tasks: _tasks,
  calls: _calls,
  appointments = [],
  messages = [],
  pautas = [],
  locationId = "",
}: DetailDrawerProps) {
  const [selectedAppointment, setSelectedAppointment] = useState<Appointment | null>(null)

  const opportunity = opportunityId ? opportunities.find((o) => o.id === opportunityId) : undefined

  // Contact-only mode: no opportunity, open directly by contactId
  const resolvedContactId = opportunity?.contactId ?? contactId ?? null
  const contact = contacts.find((c) => c.id === resolvedContactId)

  if (!opportunity && !contact) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Sin selección</SheetTitle>
            <SheetDescription>Selecciona un registro de la lista para ver los detalles.</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    )
  }
  const contactAppointments = appointments
    .filter((a) => a.contactId === resolvedContactId)
    .slice()
    .sort((a, b) => b.startTime.localeCompare(a.startTime))

  const contactMessages = messages
    .filter((m) => m.contactId === resolvedContactId && m.kind !== "activity")
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const contactPautas = pautas
    .filter((p) => p.contactId === resolvedContactId)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const lastInbound = contactMessages.find((m) => m.direction === "inbound")
  const lastOutbound = contactMessages.find((m) => m.direction === "outbound")
  const latestMessage = contactMessages[0]
  const hasConversation = contactMessages.length > 0

  const statusInfo = opportunity
    ? (STATUS_STYLES[opportunity.status] ?? { badge: "bg-[#EAEDF1] text-[#151B28] border-border", label: opportunity.status })
    : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto p-0">
        {/* Header */}
        <div className="border-b border-border px-6 pt-6 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-0.5 min-w-0">
              <SheetHeader className="p-0">
                <SheetTitle className="text-[15px] font-semibold leading-snug">
                  {contact?.name ?? "Contacto no encontrado"}
                </SheetTitle>
                <SheetDescription className="text-xs text-muted-foreground mt-0.5">
                  {contact?.email ?? "Sin correo"} · {contact?.phone ?? "Sin teléfono"}
                </SheetDescription>
              </SheetHeader>
            </div>
            {statusInfo && (
              <Badge
                variant="outline"
                className={`text-[11px] shrink-0 capitalize font-medium ${statusInfo.badge}`}
              >
                {statusInfo.label}
              </Badge>
            )}
          </div>

          {/* Tags */}
          {contact?.tags && contact.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {contact.tags.map((tag) => (
                <span
                  key={tag}
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${getTagStyle(tag)}`}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Action buttons */}
          {locationId && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {opportunity && (
                <Button asChild variant="outline" size="sm" className="h-7 text-xs gap-1.5">
                  <a
                    href={`https://login.lezgosuite.com/v2/location/${locationId}/opportunities/${opportunity.id}?tab=Opportunity+Details`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Ver oportunidad
                  </a>
                </Button>
              )}
              {contact && (
                <Button asChild variant="outline" size="sm" className="h-7 text-xs gap-1.5">
                  <a
                    href={`https://login.lezgosuite.com/v2/location/${locationId}/contacts/detail/${contact.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Ver contacto
                  </a>
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Scrollable body */}
        <div className="flex flex-col gap-5 px-6 py-5 pb-8">

          {/* Opportunity section — only when an opportunity is linked */}
          {opportunity && (
            <>
              <div>
                <SectionLabel>Oportunidad</SectionLabel>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <InfoCell icon={<DollarSign className="h-3.5 w-3.5" />} label="Valor">
                    <span className="font-variant-numeric tabular-nums">
                      {opportunity.value ? formatCurrency(opportunity.value) : "Sin valor"}
                    </span>
                  </InfoCell>
                  <InfoCell icon={<Calendar className="h-3.5 w-3.5" />} label="Cierre">
                    {opportunity.closedAt
                      ? new Date(opportunity.closedAt).toLocaleDateString("es-MX", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })
                      : "No disponible"}
                  </InfoCell>
                  <InfoCell icon={<User className="h-3.5 w-3.5" />} label="Etapa">
                    {opportunity.stage ?? "No disponible"}
                  </InfoCell>
                  <InfoCell icon={<GitBranch className="h-3.5 w-3.5" />} label="Pipeline">
                    {opportunity.pipelineName ?? "No disponible"}
                  </InfoCell>
                  {opportunity.assignedTo && (
                    <InfoCell icon={<User className="h-3.5 w-3.5" />} label="Asignado a" className="col-span-2">
                      {opportunity.assignedTo}
                    </InfoCell>
                  )}
                </div>
              </div>
              <Divider />
            </>
          )}

          {/* Contact section */}
          <div>
            <SectionLabel>Contacto</SectionLabel>
            {!contact ? (
              <p className="text-xs text-muted-foreground italic">Contacto no vinculado.</p>
            ) : (
              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                <InfoCell icon={<User className="h-3.5 w-3.5" />} label="Nombre">
                  {contact.name}
                </InfoCell>
                <InfoCell icon={<Mail className="h-3.5 w-3.5" />} label="Email">
                  {contact.email || "Sin correo"}
                </InfoCell>
                <InfoCell icon={<Phone className="h-3.5 w-3.5" />} label="Teléfono">
                  {contact.phone || "Sin teléfono"}
                </InfoCell>
                {contact.assignedTo && (
                  <InfoCell icon={<User className="h-3.5 w-3.5" />} label="Asignado a">
                    {contact.assignedTo}
                  </InfoCell>
                )}
                <InfoCell icon={<UserPlus className="h-3.5 w-3.5" />} label="Registro">
                  {contact.createdAt
                    ? new Date(contact.createdAt).toLocaleDateString("es-MX", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })
                    : "No disponible"}
                </InfoCell>
                <InfoCell icon={<Megaphone className="h-3.5 w-3.5" />} label="Medio">
                  {contact.adType || "No disponible"}
                </InfoCell>
              </div>
            )}
          </div>

          {/* Conversation section */}
          {hasConversation && (
            <>
              <Divider />
              <div>
                <div className="flex items-center justify-between mb-3">
                  <SectionLabel>Conversación</SectionLabel>
                  {latestMessage && (
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-3">
                      <ChannelIcon source={latestMessage.source} />
                      <span>{CHANNEL_LABELS[latestMessage.source] ?? latestMessage.source}</span>
                      <span className="mx-0.5">·</span>
                      <span>{formatRelativeTime(latestMessage.createdAt)}</span>
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  {lastInbound && (
                    <MessageRow
                      direction="inbound"
                      content={lastInbound.content}
                      time={lastInbound.createdAt}
                      source={lastInbound.source}
                    />
                  )}
                  {lastOutbound && (
                    <MessageRow
                      direction="outbound"
                      content={lastOutbound.content}
                      time={lastOutbound.createdAt}
                      source={lastOutbound.source}
                    />
                  )}
                  <p className="text-[10px] text-muted-foreground pt-0.5">
                    {contactMessages.length} mensaje{contactMessages.length !== 1 ? "s" : ""} en total
                  </p>
                </div>
              </div>
            </>
          )}

          {/* Pautas section */}
          <Divider />
          <div>
            <SectionLabel>Pautas</SectionLabel>
            {contactPautas.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Sin pautas registradas.</p>
            ) : (
              <div className="flex flex-col">
                {contactPautas.map((pauta, idx) => (
                  <div
                    key={pauta.id}
                    className={`flex items-start gap-3 py-3 ${idx !== 0 ? "border-t border-border" : ""}`}
                  >
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-100 mt-0.5">
                      <FileText className="h-3 w-3 text-violet-600" />
                    </div>
                    <div className="flex flex-col gap-1 flex-1 min-w-0">
                      <span className="text-sm font-medium text-foreground leading-snug">
                        {pauta.nombrePauta.split(" - ")[0] || pauta.nombrePauta}
                      </span>
                      <div className="flex items-center gap-2 flex-wrap">
                        {pauta.tipo && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 border border-violet-200 px-2 py-0.5 text-[10px] font-medium text-violet-700">
                            <Tag className="h-2.5 w-2.5" />
                            {pauta.tipo}
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground">
                          {new Date(pauta.createdAt).toLocaleDateString("es-MX", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                          })}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Appointments section */}
          <Divider />
          <div>
            <SectionLabel>Citas</SectionLabel>
            {contactAppointments.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Sin citas registradas.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {contactAppointments.map((appt) => {
                  const status = (appt.status ?? "").toLowerCase()
                  const isConfirmed = ["confirmed", "showed"].includes(status)
                  const isCancelled = ["cancelled", "noshow", "no_show"].includes(status)
                  const Icon = isConfirmed ? CalendarCheck : isCancelled ? CalendarX : CalendarClock
                  const iconBg = isConfirmed ? "bg-emerald-100" : isCancelled ? "bg-red-100" : "bg-amber-100"
                  const iconColor = isConfirmed ? "text-emerald-600" : isCancelled ? "text-red-500" : "text-[#F59B1B]"
                  const badgeClass = isConfirmed
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : isCancelled
                    ? "bg-red-50 text-red-600 border-red-200"
                    : "bg-[#FEF3C7] text-[#92400E] border-[#FCD34D]"
                  const startDate = new Date(appt.startTime)
                  const dateStr = startDate.toLocaleDateString("es-MX", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  })
                  const timeStr = startDate.toLocaleTimeString("es-MX", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                  return (
                    <button
                      key={appt.id}
                      type="button"
                      onClick={() => setSelectedAppointment(appt)}
                      className="flex items-start gap-3 rounded-lg border border-border p-3 text-left hover:border-primary/40 hover:bg-accent/30 transition-colors w-full"
                    >
                      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${iconBg}`}>
                        <Icon className={`h-3.5 w-3.5 ${iconColor}`} />
                      </div>
                      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                        <span className="text-sm font-medium text-foreground truncate">
                          {appt.title ?? "Cita"}
                        </span>
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span>{dateStr}</span>
                          <span className="tabular-nums">{timeStr}</span>
                        </div>
                        {appt.notes && (
                          <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{appt.notes}</p>
                        )}
                      </div>
                      <Badge variant="outline" className={`text-[10px] shrink-0 capitalize ${badgeClass}`}>
                        {appt.status || "pendiente"}
                      </Badge>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <AppointmentDetailDialog
          appointment={selectedAppointment}
          onClose={() => setSelectedAppointment(null)}
        />
      </SheetContent>
    </Sheet>
  )
}

function Divider() {
  return <div className="h-px bg-border" />
}

function InfoCell({
  icon,
  label,
  children,
  className = "",
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={`flex items-start gap-2 ${className}`}>
      <span className="mt-0.5 text-muted-foreground shrink-0">{icon}</span>
      <div>
        <p className="text-[10px] text-muted-foreground mb-0.5">{label}</p>
        <p className="text-sm font-semibold text-foreground leading-snug">{children}</p>
      </div>
    </div>
  )
}

function MessageRow({
  direction,
  content,
  time,
  source,
}: {
  direction: "inbound" | "outbound"
  content?: string
  time: string
  source: string
}) {
  const isInbound = direction === "inbound"
  return (
    <div className="rounded-lg border border-border p-3 flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {isInbound ? (
            <ArrowDownLeft className="h-3 w-3 text-[#335577]" />
          ) : (
            <ArrowUpRight className="h-3 w-3 text-[#F59B1B]" />
          )}
          <span className={`text-[10px] font-semibold ${isInbound ? "text-[#335577]" : "text-[#D9870F]"}`}>
            {isInbound ? "Lead" : "Nosotros"}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <ChannelIcon source={source} />
          <span>{formatRelativeTime(time)}</span>
        </div>
      </div>
      {content ? (
        <p className="text-xs text-foreground line-clamp-3 leading-relaxed">{content}</p>
      ) : (
        <p className="text-xs text-muted-foreground italic">Sin contenido</p>
      )}
    </div>
  )
}

function AppointmentDetailDialog({
  appointment,
  onClose,
}: {
  appointment: Appointment | null
  onClose: () => void
}) {
  const open = appointment !== null
  const status = (appointment?.status ?? "").toLowerCase()
  const isConfirmed = ["confirmed", "showed"].includes(status)
  const isCancelled = ["cancelled", "noshow", "no_show"].includes(status)
  const Icon = isConfirmed ? CalendarCheck : isCancelled ? CalendarX : CalendarClock
  const iconBg = isConfirmed ? "bg-emerald-100" : isCancelled ? "bg-red-100" : "bg-amber-100"
  const iconColor = isConfirmed ? "text-emerald-600" : isCancelled ? "text-red-500" : "text-[#F59B1B]"
  const badgeClass = isConfirmed
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : isCancelled
    ? "bg-red-50 text-red-600 border-red-200"
    : "bg-[#FEF3C7] text-[#92400E] border-[#FCD34D]"

  let dateStr = ""
  let startTimeStr = ""
  let endTimeStr = ""
  let durationStr = ""
  if (appointment) {
    const start = new Date(appointment.startTime)
    const end = new Date(appointment.endTime)
    dateStr = start.toLocaleDateString("es-MX", {
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
    })
    startTimeStr = start.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
    endTimeStr = end.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
    const mins = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000))
    if (mins >= 60) {
      const h = Math.floor(mins / 60)
      const m = mins % 60
      durationStr = m > 0 ? `${h}h ${m}min` : `${h}h`
    } else if (mins > 0) {
      durationStr = `${mins} min`
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${iconBg}`}>
              <Icon className={`h-4 w-4 ${iconColor}`} />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base leading-snug">
                {appointment?.title ?? "Cita"}
              </DialogTitle>
              {/* Radix exige una descripción ligada al DialogContent */}
              <DialogDescription className="sr-only">
                Detalle de la cita: fecha, horario y contacto asociado.
              </DialogDescription>
              <div className="text-xs mt-1">
                <Badge variant="outline" className={`text-[10px] capitalize ${badgeClass}`}>
                  {appointment?.status || "pendiente"}
                </Badge>
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-3 mt-2">
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Fecha</p>
            </div>
            <p className="text-sm text-foreground capitalize">{dateStr}</p>
            <div className="flex items-center gap-2 mt-2 text-sm text-foreground">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="tabular-nums">
                {startTimeStr} – {endTimeStr}
                {durationStr && <span className="text-muted-foreground"> · {durationStr}</span>}
              </span>
            </div>
          </div>

          {appointment?.assignedTo && (
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <User className="h-3.5 w-3.5 text-muted-foreground" />
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Asignado a</p>
              </div>
              <p className="text-sm text-foreground">{appointment.assignedTo}</p>
            </div>
          )}

          {appointment?.location && (() => {
            const isVirtual = appointment.location.startsWith("http")
            return (
              <div className="rounded-lg border border-border p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  {isVirtual
                    ? <Video className="h-3.5 w-3.5 text-muted-foreground" />
                    : <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                  }
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                    {isVirtual ? "Reunión virtual" : "Ubicación"}
                  </p>
                </div>
                {isVirtual ? (
                  <a
                    href={appointment.location}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary hover:underline flex items-center gap-1.5 break-all"
                  >
                    {appointment.location}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                ) : (
                  <p className="text-sm text-foreground">{appointment.location}</p>
                )}
              </div>
            )
          })()}

          {appointment?.notes && (
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Notas</p>
              </div>
              <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                {appointment.notes}
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
