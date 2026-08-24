// lib/conversations-panel.ts
import type {
  Contact,
  Message,
  MessageChannel,
} from "@/lib/types";
import type { ChatDataset } from "@/lib/ai-tools";

// ─── Shared bits ────────────────────────────────────────────────────────────

export type UrgencyBucket = "red" | "yellow" | "grey" | "none";

export interface ContactUrgency {
  channel?: MessageChannel | "system";
  lastActivityAt?: string;
  unanswered: boolean;
  bucket: UrgencyBucket;
}

// ─── Panel state types (moved here from the component) ───────────────────────

export interface PanelContact {
  id: string;
  name: string;
  source?: string;
  assignedTo?: string;
  tags?: string[];
  lastActivity?: string;
  // enriched (optional — absent when contact not in the in-memory dataset)
  channel?: MessageChannel | "system";
  lastActivityAt?: string;
  unanswered?: boolean;
  urgency?: UrgencyBucket;
}

export interface SummaryGroup {
  key: string;
  count: number;
  sum?: number;
}

export interface PanelOpportunity {
  id: string;
  name: string;
  pipelineName: string;
  stage: string;
  status: string;
  value: number;
  currency?: string;
}

export interface PanelAppointment {
  id: string;
  title?: string;
  startTime: string;
  status: string;
}

export interface PanelPauta {
  id: string;
  nombrePauta: string;
  tipo?: string;
  createdAt: string;
}

export interface PanelMessage {
  direction: "inbound" | "outbound";
  source: string;
  content?: string;
  createdAt: string;
}

export interface PanelContactInfo extends PanelContact {
  email?: string;
  phone?: string;
  companyName?: string;
  createdAt?: string;
  adType?: string;
}

export type PanelState =
  | { mode: "idle" }
  | {
      mode: "summary";
      query?: string;
      title?: string;
      contacts: PanelContact[];
      groups?: SummaryGroup[];
      total: number;
      valueAtRisk?: number;
      urgency?: { red: number; yellow: number; grey: number };
      channels?: { key: string; count: number }[];
    }
  | {
      mode: "contact";
      contact: PanelContactInfo;
      status?: string;
      opportunities: PanelOpportunity[];
      appointments: PanelAppointment[];
      pautas: PanelPauta[];
      lastInbound: PanelMessage | null;
      lastOutbound: PanelMessage | null;
      messageCount: number;
      prevSummary?: Extract<PanelState, { mode: "summary" }>;
    };

// ─── Urgency ─────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;

export function computeContactUrgency(
  contactId: string,
  messages: Message[],
): ContactUrgency {
  const msgs = messages
    .filter((m) => m.contactId === contactId && m.kind !== "activity")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const last = msgs[0];
  if (!last) return { unanswered: false, bucket: "none" };

  const unanswered = last.direction === "inbound";
  const ageH = (Date.now() - new Date(last.createdAt).getTime()) / HOUR;
  let bucket: UrgencyBucket = "grey";
  if (unanswered) {
    if (ageH > 72) bucket = "red";
    else if (ageH >= 24) bucket = "yellow";
    else bucket = "grey";
  }
  return {
    channel: last.source,
    lastActivityAt: last.createdAt,
    unanswered,
    bucket,
  };
}

// ─── Summary builder ──────────────────────────────────────────────────────────

const URGENCY_RANK: Record<UrgencyBucket, number> = {
  red: 0,
  yellow: 1,
  grey: 2,
  none: 3,
};

interface BuildSummaryOpts {
  title?: string;
  query?: string;
  total?: number;
  groups?: SummaryGroup[];
}

export function buildSummaryState(
  contacts: PanelContact[],
  dataset: ChatDataset,
  opts: BuildSummaryOpts = {},
): Extract<PanelState, { mode: "summary" }> {
  // Enrich each contact with urgency/channel from in-memory messages.
  const enriched: PanelContact[] = contacts.map((c) => {
    const u = computeContactUrgency(c.id, dataset.messages);
    return {
      ...c,
      channel: u.channel,
      lastActivityAt: u.lastActivityAt,
      unanswered: u.unanswered,
      urgency: u.bucket,
    };
  });

  enriched.sort((a, b) => {
    const r =
      URGENCY_RANK[a.urgency ?? "none"] - URGENCY_RANK[b.urgency ?? "none"];
    if (r !== 0) return r;
    // within a bucket, oldest activity first (most urgent)
    return (a.lastActivityAt ?? "").localeCompare(b.lastActivityAt ?? "");
  });

  const urgency = { red: 0, yellow: 0, grey: 0 };
  for (const c of enriched) {
    if (c.urgency === "red") urgency.red++;
    else if (c.urgency === "yellow") urgency.yellow++;
    else if (c.urgency === "grey") urgency.grey++;
  }
  const anyMessages = enriched.some((c) => c.urgency && c.urgency !== "none");

  const channelCounts = new Map<string, number>();
  for (const c of enriched) {
    if (!c.channel || c.channel === "system") continue;
    channelCounts.set(c.channel, (channelCounts.get(c.channel) ?? 0) + 1);
  }
  const channels = Array.from(channelCounts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);

  const idSet = new Set(enriched.map((c) => c.id));
  const valueAtRisk = dataset.opportunities
    .filter((o) => idSet.has(o.contactId) && o.status === "open")
    .reduce((s, o) => s + (typeof o.value === "number" ? o.value : 0), 0);

  return {
    mode: "summary",
    title: opts.title,
    query: opts.query,
    contacts: enriched,
    groups: opts.groups,
    total: opts.total ?? enriched.length,
    valueAtRisk: valueAtRisk > 0 ? valueAtRisk : undefined,
    urgency: anyMessages ? urgency : undefined,
    channels: channels.length > 0 ? channels : undefined,
  };
}

// ─── Contact builder ──────────────────────────────────────────────────────────

export function buildContactState(
  contactId: string,
  dataset: ChatDataset,
  prevSummary?: Extract<PanelState, { mode: "summary" }>,
): Extract<PanelState, { mode: "contact" }> {
  const c: Contact | undefined = dataset.contacts.find(
    (x) => x.id === contactId,
  );

  const opportunities: PanelOpportunity[] = dataset.opportunities
    .filter((o) => o.contactId === contactId)
    .map((o) => ({
      id: o.id,
      name: o.name,
      pipelineName: o.pipelineName,
      stage: o.stage,
      status: o.status,
      value: o.value,
      currency: o.currency || undefined,
    }));

  const appointments: PanelAppointment[] = dataset.appointments
    .filter((a) => a.contactId === contactId)
    .sort((a, b) => b.startTime.localeCompare(a.startTime))
    .map((a) => ({
      id: a.id,
      title: a.title || undefined,
      startTime: a.startTime,
      status: a.status,
    }));

  const pautas: PanelPauta[] = dataset.pautas
    .filter((p) => p.contactId === contactId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((p) => ({
      id: p.id,
      nombrePauta: p.nombrePauta,
      tipo: p.tipo || undefined,
      createdAt: p.createdAt,
    }));

  const msgs = dataset.messages
    .filter((m) => m.contactId === contactId && m.kind !== "activity")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const toPanelMsg = (m: (typeof msgs)[number]): PanelMessage => ({
    direction: m.direction,
    source: m.source,
    content: m.content,
    createdAt: m.createdAt,
  });
  const lastInbound = msgs.find((m) => m.direction === "inbound");
  const lastOutbound = msgs.find((m) => m.direction === "outbound");

  return {
    mode: "contact",
    contact: {
      id: contactId,
      name: c?.name || c?.email || c?.phone || contactId,
      source: c?.source || undefined,
      assignedTo: c?.assignedTo || undefined,
      tags: c?.tags?.length ? c.tags : undefined,
      email: c?.email || undefined,
      phone: c?.phone || undefined,
      companyName: c?.companyName || undefined,
      createdAt: c?.createdAt || undefined,
      adType: c?.adType || undefined,
    },
    status: opportunities[0]?.status,
    opportunities,
    appointments,
    pautas,
    lastInbound: lastInbound ? toPanelMsg(lastInbound) : null,
    lastOutbound: lastOutbound ? toPanelMsg(lastOutbound) : null,
    messageCount: msgs.length,
    prevSummary,
  };
}
