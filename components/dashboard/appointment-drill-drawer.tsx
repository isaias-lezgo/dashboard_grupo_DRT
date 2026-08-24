"use client"

import { motion } from "framer-motion"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import type { Appointment, Contact } from "@/lib/types"
import { CalendarCheck, CalendarX, CalendarClock, User, Phone, Mail, Tag, Megaphone, Clock, MapPin, Video, ExternalLink } from "lucide-react"

export interface ApptDrillState {
  open: boolean
  title: string
  appointments: Appointment[]
}

export const APPT_DRILL_CLOSED: ApptDrillState = { open: false, title: "", appointments: [] }

interface AppointmentDrillDrawerProps {
  drill: ApptDrillState
  onDrillChange: (d: ApptDrillState) => void
  contacts: Contact[]
}

function statusVisual(status: string): {
  Icon: typeof CalendarCheck
  iconBg: string
  iconColor: string
  badgeClass: string
} {
  const s = status.toLowerCase()
  if (s === "showed" || s === "confirmed") {
    return {
      Icon: CalendarCheck,
      iconBg: "bg-emerald-100",
      iconColor: "text-emerald-600",
      badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-200",
    }
  }
  if (s === "noshow" || s === "no_show" || s === "cancelled") {
    return {
      Icon: CalendarX,
      iconBg: "bg-red-100",
      iconColor: "text-red-500",
      badgeClass: "bg-red-50 text-red-600 border-red-200",
    }
  }
  return {
    Icon: CalendarClock,
    iconBg: "bg-amber-100",
    iconColor: "text-amber-600",
    badgeClass: "bg-amber-50 text-amber-700 border-amber-200",
  }
}

export function AppointmentDrillDrawer({
  drill,
  onDrillChange,
  contacts,
}: AppointmentDrillDrawerProps) {
  const contactById = new Map(contacts.map((c) => [c.id, c]))
  const sorted = [...drill.appointments].sort((a, b) =>
    b.startTime.localeCompare(a.startTime)
  )
  const count = drill.appointments.length

  return (
    <Sheet open={drill.open} onOpenChange={(o) => onDrillChange({ ...drill, open: o })}>
      <SheetContent className="w-[500px] sm:max-w-[500px] p-0 flex flex-col overflow-hidden">
        <div className="border-b border-border px-6 pt-5 pb-4 flex-none">
          <SheetHeader>
            <SheetTitle className="text-[15px] font-semibold leading-snug pr-6">
              {drill.title}
            </SheetTitle>
            {/* Radix exige una descripción ligada al SheetContent */}
            <SheetDescription className="sr-only">
              Listado de las citas del segmento seleccionado.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-2.5 flex items-center gap-2">
            <Badge variant="secondary" className="rounded-full text-xs font-semibold tabular-nums">
              {count.toLocaleString()} cita{count !== 1 ? "s" : ""}
            </Badge>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {count === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              Sin citas en este segmento.
            </div>
          ) : (
            sorted.map((appt, i) => {
              const contact = contactById.get(appt.contactId)
              const { Icon, iconBg, iconColor, badgeClass } = statusVisual(appt.status)
              const start = new Date(appt.startTime)
              const dateStr = start.toLocaleDateString("es-MX", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })
              const timeStr = start.toLocaleTimeString("es-MX", {
                hour: "2-digit",
                minute: "2-digit",
              })
              const end = new Date(appt.endTime)
              const durationMs = end.getTime() - start.getTime()
              const durationMin = Math.round(durationMs / 60_000)
              const durationStr = durationMin >= 60
                ? `${Math.floor(durationMin / 60)}h ${durationMin % 60 > 0 ? `${durationMin % 60}min` : ""}`.trim()
                : `${durationMin} min`

              return (
                <motion.div
                  key={appt.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.025, 0.4), duration: 0.18 }}
                  className="rounded-xl border border-border bg-card p-4 space-y-3"
                >
                  {/* Header row: icon + title + badge */}
                  <div className="flex items-start gap-3">
                    <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${iconBg}`}>
                      <Icon className={`h-3.5 w-3.5 ${iconColor}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground leading-snug">
                        {appt.title ?? "Cita"}
                      </p>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                        <span>{dateStr}</span>
                        <span>{timeStr}</span>
                        {durationMin > 0 && (
                          <>
                            <span className="text-border">·</span>
                            <span className="flex items-center gap-0.5">
                              <Clock className="h-2.5 w-2.5" />
                              {durationStr}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className={`text-[10px] shrink-0 capitalize ${badgeClass}`}
                    >
                      {appt.status}
                    </Badge>
                  </div>

                  {/* Contact info */}
                  <div className="space-y-1.5 pl-10">
                    <div className="flex items-center gap-1.5 text-[11px] text-foreground">
                      <User className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="font-medium">{contact?.name ?? "Contacto desconocido"}</span>
                    </div>
                    {contact?.phone && (
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Phone className="h-3 w-3 shrink-0" />
                        <span>{contact.phone}</span>
                      </div>
                    )}
                    {contact?.email && (
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Mail className="h-3 w-3 shrink-0" />
                        <span className="truncate">{contact.email}</span>
                      </div>
                    )}
                    {(contact?.source || contact?.campaign) && (
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Megaphone className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          {[contact.source, contact.campaign].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                    )}
                    {contact?.tags && contact.tags.length > 0 && (
                      <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                        <Tag className="h-3 w-3 shrink-0 mt-0.5" />
                        <div className="flex flex-wrap gap-1">
                          {contact.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Location / meeting link */}
                    {appt.location && (() => {
                      const isVirtual = appt.location.startsWith("http")
                      return (
                        <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                          {isVirtual
                            ? <Video className="h-3 w-3 shrink-0 mt-0.5" />
                            : <MapPin className="h-3 w-3 shrink-0 mt-0.5" />
                          }
                          {isVirtual ? (
                            <a
                              href={appt.location}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-500 hover:underline flex items-center gap-1 break-all"
                            >
                              {appt.location}
                              <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                            </a>
                          ) : (
                            <span>{appt.location}</span>
                          )}
                        </div>
                      )
                    })()}
                  </div>

                  {/* Notes */}
                  {appt.notes && (
                    <p className="pl-10 text-[11px] text-muted-foreground leading-relaxed border-t border-border pt-2.5">
                      {appt.notes}
                    </p>
                  )}
                </motion.div>
              )
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
