"use client";

import { useState } from "react";
import { ExternalLink, Clock, ArrowLeft, Calendar, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  PanelState,
  PanelContact,
  UrgencyBucket,
} from "@/lib/conversations-panel";

export type {
  PanelState,
  PanelContact,
} from "@/lib/conversations-panel";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  review: "Reseña",
  form_submission: "Formulario",
  other: "Otro",
};

function channelLabel(source?: string): string {
  if (!source) return "";
  return CHANNEL_LABELS[source] ?? source;
}

const URGENCY_DOT: Record<UrgencyBucket, string> = {
  red: "bg-destructive",
  yellow: "bg-amber-500",
  grey: "bg-muted-foreground/50",
  none: "bg-transparent",
};

const URGENCY_BADGE: Record<UrgencyBucket, string> = {
  red: "bg-destructive/15 text-destructive",
  yellow: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  grey: "bg-muted text-muted-foreground",
  none: "bg-muted text-muted-foreground",
};

const CHANNEL_BAR = [
  "bg-emerald-500",
  "bg-blue-500",
  "bg-pink-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-muted-foreground/50",
];

// ─── Component ────────────────────────────────────────────────────────────────

interface ConversationsContextPanelProps {
  state: PanelState;
  locationId?: string;
  onContactClick?: (contact: PanelContact) => void;
  onBack?: () => void;
}

export function ConversationsContextPanel({
  state,
  locationId,
  onContactClick,
  onBack,
}: ConversationsContextPanelProps) {
  return (
    <div
      className={cn(
        "flex w-full flex-shrink-0 flex-col border-border bg-muted/10",
        "md:h-full md:w-[300px] md:border-r",
        // On mobile the panel stacks above the chat. When there's nothing to
        // show, collapse it entirely so the chat keeps the full viewport; when
        // populated, cap its height so the chat still gets the larger share.
        state.mode === "idle"
          ? "hidden md:flex"
          : "max-h-[40vh] border-b md:max-h-none md:border-b-0",
      )}
    >
      {state.mode === "idle" && <IdlePanel />}
      {state.mode === "summary" && (
        <SummaryPanel state={state} onContactClick={onContactClick} />
      )}
      {state.mode === "contact" && (
        <ContactPanel state={state} locationId={locationId} onBack={onBack} />
      )}
    </div>
  );
}

// ─── Idle ─────────────────────────────────────────────────────────────────────

function IdlePanel() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
        <Clock className="h-5 w-5 text-primary/60" />
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        El contexto aparecerá aquí cuando la IA encuentre contactos o conversaciones.
      </p>
    </div>
  );
}

// ─── Summary (triage) ──────────────────────────────────────────────────────────

function SummaryPanel({
  state,
  onContactClick,
}: {
  state: Extract<PanelState, { mode: "summary" }>;
  onContactClick?: (c: PanelContact) => void;
}) {
  const total = state.total;
  const channelTotal = (state.channels ?? []).reduce((s, c) => s + c.count, 0);
  const [showAll, setShowAll] = useState(false);
  const COLLAPSED_COUNT = 10;
  const uniqueContacts = state.contacts.filter(
    (c, i, arr) => arr.findIndex((x) => x.id === c.id) === i,
  );
  const visibleContacts = showAll
    ? uniqueContacts
    : uniqueContacts.slice(0, COLLAPSED_COUNT);
  const hiddenCount = uniqueContacts.length - COLLAPSED_COUNT;
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <p className="text-xs font-semibold text-foreground">
          {state.title ?? "Resumen"} · {total}{" "}
          {total === 1 ? "contacto" : "contactos"}
        </p>
        {state.query && (
          <p className="mt-0.5 text-[10px] text-muted-foreground line-clamp-2">
            {state.query}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-2.5 p-3">
          {/* Urgency */}
          {state.urgency && (
            <div className="rounded-md border border-border/50 bg-background p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Urgencia
              </p>
              <div className="mb-2.5 flex gap-1.5">
                {state.urgency.red > 0 && (
                  <div
                    className="h-1.5 rounded-full bg-destructive"
                    style={{ flex: state.urgency.red }}
                  />
                )}
                {state.urgency.yellow > 0 && (
                  <div
                    className="h-1.5 rounded-full bg-amber-500"
                    style={{ flex: state.urgency.yellow }}
                  />
                )}
                {state.urgency.grey > 0 && (
                  <div
                    className="h-1.5 rounded-full bg-muted-foreground/40"
                    style={{ flex: state.urgency.grey }}
                  />
                )}
              </div>
              <div className="space-y-1">
                <UrgencyRow
                  color="bg-destructive"
                  count={state.urgency.red}
                  label="sin respuesta +3d"
                />
                <UrgencyRow
                  color="bg-amber-500"
                  count={state.urgency.yellow}
                  label="+24h"
                />
                <UrgencyRow
                  color="bg-muted-foreground/50"
                  count={state.urgency.grey}
                  label="recientes"
                />
              </div>
            </div>
          )}

          {/* Value at risk + channels */}
          {((state.valueAtRisk !== undefined && state.valueAtRisk > 0) ||
            (state.channels && state.channels.length > 0)) && (
            <div className="flex gap-2">
              {state.valueAtRisk !== undefined && state.valueAtRisk > 0 && (
                <div className="flex-1 rounded-md border border-border/50 bg-background p-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    En riesgo
                  </p>
                  <p className="mt-0.5 text-sm font-bold tabular-nums">
                    ${state.valueAtRisk.toLocaleString("es-MX")}
                  </p>
                </div>
              )}
              {state.channels && state.channels.length > 0 && (
                <div className="flex-1 rounded-md border border-border/50 bg-background p-2.5">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Canales
                  </p>
                  <div className="flex h-2 overflow-hidden rounded-full bg-muted">
                    {state.channels.map((c, i) => (
                      <div
                        key={c.key}
                        className={cn(
                          "h-full",
                          CHANNEL_BAR[i % CHANNEL_BAR.length],
                        )}
                        style={{
                          width: `${channelTotal ? (c.count / channelTotal) * 100 : 0}%`,
                        }}
                      />
                    ))}
                  </div>
                  <p className="mt-1.5 truncate text-[9px] text-muted-foreground">
                    {state.channels
                      .slice(0, 3)
                      .map((c) => channelLabel(c.key))
                      .join(" · ")}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Aggregate groups */}
          {state.groups && state.groups.length > 0 && (
            <div className="rounded-md border border-border/50 bg-background p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Distribución
              </p>
              <div className="space-y-1.5">
                {state.groups.slice(0, 8).map((g) => (
                  <div key={g.key} className="flex items-center justify-between">
                    <span className="max-w-[60%] truncate text-xs text-muted-foreground">
                      {g.key}
                    </span>
                    <span className="text-xs font-medium tabular-nums">
                      {g.sum !== undefined
                        ? `$${g.sum.toLocaleString("es-MX")}`
                        : g.count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Contact list */}
          {state.contacts.length > 0 && (
            <div className="space-y-1">
              <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {state.urgency ? "Más urgentes" : "Contactos"}
              </p>
              {visibleContacts.map((c) => {
                const bucket = c.urgency ?? "none";
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onContactClick?.(c)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/50"
                  >
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                      {initials(c.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-xs font-medium">
                        <span className="truncate">{c.name}</span>
                        {bucket !== "none" && bucket !== "grey" && (
                          <span
                            className={cn(
                              "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                              URGENCY_DOT[bucket],
                            )}
                          />
                        )}
                      </p>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {c.channel && c.channel !== "system"
                          ? `${channelLabel(c.channel)}${c.unanswered ? " · sin respuesta" : ""}`
                          : c.source ?? c.assignedTo ?? ""}
                      </p>
                    </div>
                    {c.lastActivityAt ? (
                      <span
                        className={cn(
                          "flex-shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                          URGENCY_BADGE[bucket],
                        )}
                      >
                        {relativeTime(c.lastActivityAt)}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground/60">
                        →
                      </span>
                    )}
                  </button>
                );
              })}
              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="w-full rounded-md px-2 py-1.5 text-center text-[10px] font-medium text-primary transition-colors hover:bg-muted/50"
                >
                  {showAll ? "Ver menos" : `Ver los ${state.contacts.length} →`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function UrgencyRow({
  color,
  count,
  label,
}: {
  color: string;
  count: number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className={cn("h-1.5 w-1.5 rounded-full", color)} />
      <span className="font-semibold tabular-nums">{count}</span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

// ─── Contact detail (drawer-style, from memory) ─────────────────────────────────

function ContactPanel({
  state,
  locationId,
  onBack,
}: {
  state: Extract<PanelState, { mode: "contact" }>;
  locationId?: string;
  onBack?: () => void;
}) {
  const {
    contact,
    opportunities,
    appointments,
    pautas,
    lastInbound,
    lastOutbound,
    messageCount,
  } = state;
  const primaryOpp = opportunities[0];
  const contactUrl = locationId
    ? `https://login.lezgosuite.com/v2/location/${locationId}/contacts/detail/${contact.id}`
    : undefined;
  const oppUrl =
    locationId && primaryOpp
      ? `https://login.lezgosuite.com/v2/location/${locationId}/opportunities/${primaryOpp.id}?tab=Opportunity+Details`
      : undefined;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-border px-4 py-3">
        {state.prevSummary && (
          <button
            type="button"
            onClick={onBack}
            className="mb-2 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" />
            Volver
          </button>
        )}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">
              {initials(contact.name)}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{contact.name}</p>
              <p className="truncate text-[10px] text-muted-foreground">
                {[channelLabel(contact.channel), contact.assignedTo]
                  .filter(Boolean)
                  .join(" · ") ||
                  contact.source ||
                  ""}
              </p>
            </div>
          </div>
          {state.status && (
            <Chip
              className={cn(
                "flex-shrink-0 capitalize",
                state.status === "won" && "bg-green-100 text-green-800",
                state.status === "lost" && "bg-red-100 text-red-800",
                state.status === "open" && "bg-yellow-100 text-yellow-800",
              )}
            >
              {state.status}
            </Chip>
          )}
        </div>
        {contact.tags && contact.tags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {contact.tags.slice(0, 6).map((t) => (
              <Chip key={t}>{t}</Chip>
            ))}
          </div>
        )}
      </div>

      {/* Sections */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 p-3">
          {/* Opportunity */}
          {primaryOpp && (
            <Section label="Oportunidad">
              <div className="rounded-md border border-border/50 bg-background p-2.5">
                <p className="text-sm font-bold">
                  ${primaryOpp.value.toLocaleString("es-MX")}
                  {primaryOpp.currency ? ` ${primaryOpp.currency}` : ""}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {primaryOpp.name}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <Chip>{primaryOpp.pipelineName}</Chip>
                  <Chip>{primaryOpp.stage}</Chip>
                </div>
              </div>
            </Section>
          )}

          {/* Contact info */}
          <Section label="Contacto">
            <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-md border border-border/50 bg-background p-2.5">
              <InfoCell label="Email" value={contact.email || "—"} />
              <InfoCell label="Teléfono" value={contact.phone || "—"} />
              <InfoCell
                label="Registro"
                value={contact.createdAt ? formatDate(contact.createdAt) : "—"}
              />
              <InfoCell label="Medio" value={contact.adType || "—"} />
            </div>
          </Section>

          {/* Appointments */}
          {appointments.length > 0 && (
            <Section label="Citas">
              <div className="space-y-1.5">
                {appointments.slice(0, 3).map((a) => (
                  <div
                    key={a.id}
                    className="flex items-start gap-2 rounded-md border border-border/50 bg-background p-2.5"
                  >
                    <Calendar className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">
                        {a.title ?? "Cita"}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {formatDate(a.startTime)}
                      </p>
                    </div>
                    <Chip className="flex-shrink-0">{a.status}</Chip>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Pautas */}
          {pautas.length > 0 && (
            <Section label="Pautas">
              <div className="space-y-1.5">
                {pautas.slice(0, 3).map((p) => (
                  <div
                    key={p.id}
                    className="flex items-start gap-2 rounded-md border border-border/50 bg-background p-2.5"
                  >
                    <FileText className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-violet-500" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">
                        {p.nombrePauta.split(" - ")[0] || p.nombrePauta}
                      </p>
                      <div className="mt-1 flex items-center gap-1.5">
                        {p.tipo && <Chip>{p.tipo}</Chip>}
                        <span className="text-[10px] text-muted-foreground">
                          {formatDate(p.createdAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Conversation snippet */}
          {messageCount > 0 && (
            <Section
              label={`Conversación · ${messageCount} mensaje${messageCount !== 1 ? "s" : ""}`}
            >
              <div className="space-y-1.5">
                {lastInbound && (
                  <MsgCard msg={lastInbound} label="Lead" inbound />
                )}
                {lastOutbound && <MsgCard msg={lastOutbound} label="Nosotros" />}
                {lastInbound && !lastOutbound && (
                  <p className="px-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                    ⚠ Sin respuesta del asesor
                  </p>
                )}
              </div>
            </Section>
          )}
        </div>
      </div>

      {/* Footer links */}
      {(contactUrl || oppUrl) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-2.5">
          {contactUrl && (
            <a
              href={contactUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-[11px] text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Ver contacto
            </a>
          )}
          {oppUrl && (
            <a
              href={oppUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-[11px] text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Ver oportunidad
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[9px] text-muted-foreground">{label}</p>
      <p className="truncate text-xs font-medium">{value}</p>
    </div>
  );
}

function MsgCard({
  msg,
  label,
  inbound,
}: {
  msg: { source: string; content?: string; createdAt: string };
  label: string;
  inbound?: boolean;
}) {
  return (
    <div className="rounded-md border border-border/50 bg-background p-2.5">
      <div className="mb-1 flex items-center justify-between">
        <span
          className={cn(
            "text-[10px] font-semibold",
            inbound ? "text-sky-600 dark:text-sky-400" : "text-primary",
          )}
        >
          {inbound ? "↙ " : "↗ "}
          {label}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {relativeTime(msg.createdAt)}
        </span>
      </div>
      <p className="line-clamp-3 break-words text-xs leading-relaxed">
        {msg.content ?? "(sin contenido)"}
      </p>
    </div>
  );
}

// ─── Shared tiny components ───────────────────────────────────────────────────

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function Chip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
