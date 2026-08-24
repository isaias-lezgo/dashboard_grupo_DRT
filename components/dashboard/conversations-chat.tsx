"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Loader2,
  Send,
  Sparkles,
  RefreshCcw,
  Square,
  AlertCircle,
  ArrowUpRight,
  Wrench,
  Download,
  CalendarClock,
  TrendingUp,
  MessagesSquare,
  UserRound,
  ListChecks,
  FileText,
  Paperclip,
  X,
  FileSpreadsheet,
  Image as ImageIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ChatDataset } from "@/lib/ai-tools";
import type { Contact } from "@/lib/types";
import { buildDatasetSummary } from "@/lib/ai-context";
import {
  formatTableSummaryText,
  PDF_TEXT_PREFIX,
  TABLE_SUMMARY_PREFIX,
  type ProcessedAttachment,
  type UploadedTable,
} from "@/lib/attachments";
import {
  useAgentLoop,
  type UIMessage,
  type TextBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type ReadyAttachment,
  type ImageBlock,
  type DocumentBlock,
} from "@/hooks/use-agent-loop";
import { triggerDownload } from "@/lib/download";
import {
  buildChatMarkdown,
  buildChatJson,
  exportTimestamp,
  type ChatExportMeta,
} from "@/lib/chat-export";
import {
  buildSummaryState,
  buildContactState,
  type PanelState,
  type PanelContact,
} from "@/lib/conversations-panel";
import { ConversationsContextPanel } from "@/components/dashboard/conversations-context-panel";
import { ChatChart } from "@/components/dashboard/chat-chart";
import { ChatQuestion } from "@/components/dashboard/chat-question";
import {
  ChartDrillDrawer,
  DRILL_CLOSED,
  type DrillState,
} from "@/components/dashboard/chart-drill-drawer";
import { parseChartSpec } from "@/lib/ai-tools";

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ConversationsChatProps {
  dataset: ChatDataset;
  locationId?: string;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function buildPanelContact(row: Record<string, unknown>): PanelContact {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    source: row.source ? String(row.source) : undefined,
    assignedTo: row.assignedTo ? String(row.assignedTo) : undefined,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : undefined,
    lastActivity: row.lastActivity ? String(row.lastActivity) : undefined,
  };
}

// Resolve a contactId (e.g. from search_conversations, which only returns IDs)
// into a display-ready PanelContact using the in-memory dataset. Falls back to
// the raw ID only when the contact isn't in the loaded dataset.
function panelContactFromId(id: string, byId: Map<string, Contact>): PanelContact {
  const c = byId.get(id);
  if (!c) return { id, name: id };
  return {
    id: c.id,
    name: c.name || c.email || c.phone || c.id,
    source: c.source || undefined,
    assignedTo: c.assignedTo || undefined,
    tags: c.tags?.length ? c.tags : undefined,
    lastActivity: c.lastActivity || undefined,
  };
}

// ─── Suggestions ─────────────────────────────────────────────────────────────

type Suggestion = {
  icon: LucideIcon;
  category: string;
  title: string;
  prompt: string;
};

const SUGGESTIONS: Suggestion[] = [
  {
    icon: CalendarClock,
    category: "Citas",
    title: "Confirmaciones de la semana",
    prompt:
      "Lista las citas agendadas para esta semana y dime cuáles aún no han confirmado asistencia para enviarles un recordatorio.",
  },
  {
    icon: TrendingUp,
    category: "Oportunidades",
    title: "Negocios estancados",
    prompt:
      "¿Qué oportunidades llevan más de 7 días sin movimiento en el pipeline? Ordénalas por valor y dime el siguiente paso para cada una. Dame un gráfico por etapa.",
  },
  {
    icon: MessagesSquare,
    category: "Conversaciones",
    title: "Mensajes sin responder",
    prompt:
      "Resume las conversaciones sin responder de las últimas 24 horas, priorízalas por urgencia y dime quién espera respuesta.",
  },
  {
    icon: UserRound,
    category: "Contactos",
    title: "Perfil de un contacto",
    prompt:
      "Dame el perfil completo de [nombre del contacto]: datos, etiquetas, oportunidades abiertas y su actividad más reciente.",
  },
  {
    icon: FileText,
    category: "Reporte PDF",
    title: "Reporte semanal en PDF",
    prompt:
      "Genera un reporte en PDF de la última semana con los leads nuevos, las citas agendadas y las oportunidades ganadas. Incluye un gráfico de leads por origen y una tabla resumen por etapa del pipeline, y al final dime el nombre del archivo descargable.",
  },
  {
    icon: ListChecks,
    category: "Tareas",
    title: "Pendientes vencidos",
    prompt:
      "¿Quién tiene tareas vencidas hoy y qué seguimiento requiere cada una? Sugiéreme por dónde empezar.",
  },
];

// ─── Attachments ──────────────────────────────────────────────────────────────

const MAX_IMAGE = 5 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("No se pudo leer el archivo"));
    r.readAsDataURL(file);
  });
}

// A pending attachment shown as a chip while/after processing.
interface Attachment {
  id: string;
  filename: string;
  icon: "image" | "pdf" | "table";
  status: "processing" | "ready" | "error";
  error?: string;
  ready?: ReadyAttachment;
}

// Turn a processed-file response into content blocks + tables for send().
function toReadyAttachment(results: ProcessedAttachment[]): ReadyAttachment {
  const blocks: Array<ImageBlock | DocumentBlock | TextBlock> = [];
  const tables: UploadedTable[] = [];
  for (const r of results) {
    if (r.kind === "pdf_text") {
      blocks.push({
        type: "text",
        text: `${PDF_TEXT_PREFIX} — ${r.filename} (${r.pageCount} págs):\n${r.text}`,
      });
    } else if (r.kind === "pdf_visual") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: r.dataBase64 },
      });
    } else {
      const fileId = crypto.randomUUID();
      tables.push({
        fileId,
        filename: r.filename,
        sheetName: r.sheetName,
        schema: r.schema,
        rowCount: r.rowCount,
        rows: r.rows,
      });
      blocks.push({
        type: "text",
        text: formatTableSummaryText({
          fileId,
          filename: r.filename,
          sheetName: r.sheetName,
          rowCount: r.rowCount,
          schema: r.schema,
          stats: r.stats,
          sampleRows: r.sampleRows,
        }),
      });
    }
  }
  return { blocks, tables };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ConversationsChat({
  dataset,
  locationId,
}: ConversationsChatProps) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const processFile = useCallback(async (file: File) => {
    const id = crypto.randomUUID();
    const kind = fileExt(file.name);
    const icon: Attachment["icon"] = IMAGE_TYPES[kind] ? "image" : kind === "pdf" ? "pdf" : "table";
    setAttachments((prev) => [...prev, { id, filename: file.name, icon, status: "processing" }]);

    const fail = (msg: string) =>
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "error", error: msg } : a)),
      );
    const done = (ready: ReadyAttachment) =>
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "ready", ready } : a)),
      );

    try {
      const mediaType = IMAGE_TYPES[kind];
      if (mediaType) {
        if (file.size > MAX_IMAGE) return fail("La imagen supera 5 MB");
        const data = await readAsBase64(file);
        done({ blocks: [{ type: "image", source: { type: "base64", media_type: mediaType, data } }] });
        return;
      }
      if (kind !== "pdf" && kind !== "csv" && kind !== "xlsx" && kind !== "xls") {
        return fail(`Tipo no soportado: .${kind}`);
      }
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/attachments/process", { method: "POST", body: form });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        return fail(e.error || `Error ${res.status}`);
      }
      const { results } = (await res.json()) as { results: ProcessedAttachment[] };
      done(toReadyAttachment(results));
    } catch (err) {
      fail(err instanceof Error ? err.message : "Error al procesar");
    }
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      for (const f of Array.from(files)) void processFile(f);
    },
    [processFile],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);
  const [panelState, setPanelState] = useState<PanelState>({ mode: "idle" });
  const prevSummaryRef = useRef<Extract<PanelState, { mode: "summary" }> | null>(null);
  const [chartDrill, setChartDrill] = useState<DrillState>(DRILL_CLOSED);

  // Lookup of the in-memory contacts by id, used to resolve the bare contactIds
  // returned by search_conversations into real names + enrich the contact view.
  const contactById = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of dataset.contacts) m.set(c.id, c);
    return m;
  }, [dataset.contacts]);

  // Open the drill-down drawer for a clicked chart group. Resolves the group's
  // contactIds to full Contact records via the in-memory dataset.
  const handleChartDrill = useCallback(
    (title: string, contactIds: string[]) => {
      const items = contactIds
        .map((id) => contactById.get(id))
        .filter((c): c is Contact => Boolean(c));
      setChartDrill({ open: true, title, opportunities: [], contactItems: items });
    },
    [contactById],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // The system prompt now lives entirely in /api/chat (ASSISTANT_SYSTEM_PROMPT);
  // this block carries only the dataset summary that gets cached alongside it.
  const datasetSummary = useMemo(
    () => buildDatasetSummary(dataset, locationId),
    [dataset, locationId],
  );

  // ─── Panel updater ──────────────────────────────────────────────────────────

  const onToolExecuted = useCallback(
    (name: string, input: Record<string, unknown>, result: unknown) => {
      const r = result as Record<string, unknown>;

      const setSummary = (
        contacts: PanelContact[],
        opts: {
          title?: string;
          total?: number;
          groups?: { key: string; count: number; sum?: number }[];
        } = {},
      ) => {
        const summary = buildSummaryState(contacts, dataset, opts);
        prevSummaryRef.current = summary;
        setPanelState(summary);
      };

      const focusContact = (id: string) => {
        setPanelState((prev) =>
          buildContactState(
            id,
            dataset,
            prev.mode === "summary" ? prev : prevSummaryRef.current ?? undefined,
          ),
        );
      };

      // AI-driven panel: the model curated exactly the contacts it's reporting.
      // This is authoritative — it overrides the broad working-set that earlier
      // search_* / search_conversations calls may have pushed into the panel.
      if (name === "show_in_panel") {
        const ids = Array.isArray(input.contactIds)
          ? (input.contactIds as string[]).map(String)
          : [];
        const title =
          typeof input.title === "string" && input.title.trim()
            ? input.title.trim()
            : undefined;
        if (ids.length === 1) return focusContact(ids[0]);
        setSummary(
          ids.map((id) => panelContactFromId(id, contactById)),
          { title, total: ids.length },
        );
        return;
      }

      if (name === "search_contacts") {
        const rows = Array.isArray(r?.rows)
          ? (r.rows as Record<string, unknown>[])
          : [];
        if (rows.length > 1) {
          setSummary(rows.map(buildPanelContact), {
            total: typeof r.returned === "number" ? r.returned : rows.length,
          });
        } else if (rows.length === 1) {
          focusContact(String(rows[0].id ?? ""));
        }
        return;
      }

      if (name === "aggregate") {
        const groups = Array.isArray(r?.groups)
          ? (r.groups as Record<string, unknown>[])
          : [];
        const summary = buildSummaryState([], dataset, {
          total: typeof r.total === "number" ? r.total : 0,
          groups: groups.map((g) => ({
            key: String(g.key ?? ""),
            count: typeof g.count === "number" ? g.count : 0,
            sum: typeof g.sum === "number" ? g.sum : undefined,
          })),
        });
        prevSummaryRef.current = summary;
        setPanelState(summary);
        return;
      }

      if (name === "search_conversations") {
        const threads = Array.isArray(r?.threads)
          ? (r.threads as Record<string, unknown>[])
          : [];
        const contacts = threads.map((t) =>
          panelContactFromId(String(t.contactId ?? ""), contactById),
        );
        if (contacts.length === 1) return focusContact(contacts[0].id);
        setSummary(contacts, {
          total: typeof r.returned === "number" ? r.returned : threads.length,
        });
        return;
      }

      if (name === "get_contact") {
        const c = r as Record<string, unknown>;
        focusContact(String(c.id ?? ""));
        return;
      }
    },
    [contactById, dataset],
  );

  const {
    messages,
    busy,
    status,
    error,
    totalCost,
    totalTools,
    send,
    stop,
    reset,
    pendingQuestion,
    answer,
  } = useAgentLoop({ datasetSummary, dataset, onToolExecuted });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status, pendingQuestion]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = useCallback(() => {
    const text = input.trim();
    const ready = attachments
      .filter((a) => a.status === "ready" && a.ready)
      .map((a) => a.ready!) as ReadyAttachment[];
    const anyProcessing = attachments.some((a) => a.status === "processing");
    if (busy || anyProcessing) return;
    if (!text && ready.length === 0) return;
    setInput("");
    setAttachments([]);
    send(text, ready);
  }, [input, attachments, busy, send]);

  const handleReset = useCallback(() => {
    reset();
    setAttachments([]);
    setPanelState({ mode: "idle" });
    prevSummaryRef.current = null;
  }, [reset]);

  const handleExport = useCallback(() => {
    if (messages.length === 0) return;
    const meta: ChatExportMeta = {
      exportedAt: new Date(),
      model: "Sonnet 4.6",
      totalCost,
      totalTools,
    };
    const stamp = exportTimestamp(meta.exportedAt);
    triggerDownload({
      content: buildChatMarkdown(messages, meta),
      filename: `chat-ia-${stamp}.md`,
      mimeType: "text/markdown;charset=utf-8;",
    });
    triggerDownload({
      content: buildChatJson(messages, meta),
      filename: `chat-ia-${stamp}.json`,
      mimeType: "application/json;charset=utf-8;",
    });
  }, [messages, totalCost, totalTools]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleContactClick = useCallback(
    (contact: PanelContact) => {
      setPanelState((prev) =>
        buildContactState(
          contact.id,
          dataset,
          prev.mode === "summary" ? prev : prevSummaryRef.current ?? undefined,
        ),
      );
    },
    [dataset],
  );

  const handleBack = useCallback(() => {
    if (prevSummaryRef.current) {
      setPanelState(prevSummaryRef.current);
    }
  }, []);

  return (
    <div className="flex h-[calc(100dvh-112px)] flex-col overflow-hidden md:h-[calc(100vh-112px)] md:flex-row">
      {/* Context panel: stacked above the chat on mobile, side rail on desktop */}
      <ConversationsContextPanel
        state={panelState}
        locationId={locationId}
        onContactClick={handleContactClick}
        onBack={handleBack}
      />

      {/* Chat */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3 sm:px-5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Asistente IA</p>
            <p className="hidden truncate text-[10px] text-muted-foreground sm:block">
              Pregunta, analiza y genera reportes en PDF con gráficos y tablas.
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <span className="text-right text-[10px] text-muted-foreground/60 tabular-nums">
              Claude · {totalTools}{" "}
              {totalTools === 1 ? "herramienta" : "herramientas"} · ~$
              {totalCost.toFixed(4)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={busy || messages.length === 0}
              title="Exporta la conversación (Markdown + JSON) con tus mensajes, las respuestas de la IA y el uso de herramientas."
              className="h-7 gap-1.5 px-2.5 text-[10px]"
            >
              <Download className="h-3 w-3" />
              <span className="hidden sm:inline">Exportar chat con IA</span>
            </Button>
          </div>
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6"
        >
          {messages.length === 0 && !busy && (
            <ConvEmptyState onSuggest={(s) => setInput(s)} />
          )}

          {messages.map((m, i) => (
            <ConvMessageBubble key={i} message={m} onDrill={handleChartDrill} />
          ))}

          {pendingQuestion && !busy && (
            <ChatQuestion question={pendingQuestion} onAnswer={answer} />
          )}

          {busy && status && (
            <div className="flex items-center gap-2.5 py-1 text-xs text-muted-foreground">
              <span className="flex gap-0.5">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-primary/60"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </span>
              {status}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
        </div>

        {/* Input bar */}
        <div
          className="border-t border-border px-4 py-4 sm:px-5"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
          }}
        >
          {dragOver && (
            <div className="mb-2 rounded-lg border border-dashed border-primary/50 bg-primary/5 px-3 py-2 text-center text-[11px] text-muted-foreground">
              Suelta el archivo aquí
            </div>
          )}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((a) => (
                <div
                  key={a.id}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
                    a.status === "error"
                      ? "border-destructive/40 bg-destructive/10 text-destructive"
                      : "border-border bg-muted/40",
                  )}
                >
                  {a.icon === "image" ? (
                    <ImageIcon className="h-3 w-3" />
                  ) : a.icon === "pdf" ? (
                    <FileText className="h-3 w-3" />
                  ) : (
                    <FileSpreadsheet className="h-3 w-3" />
                  )}
                  <span className="max-w-[140px] truncate">{a.filename}</span>
                  {a.status === "processing" && <Loader2 className="h-3 w-3 animate-spin" />}
                  {a.status === "error" && <span title={a.error}>· error</span>}
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Quitar archivo"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData.files).filter((f) =>
                f.type.startsWith("image/"),
              );
              if (imgs.length) {
                e.preventDefault();
                addFiles(imgs);
              }
            }}
            placeholder="¿Qué quieres saber?"
            rows={2}
            className="min-h-[52px] w-full resize-none text-sm"
            disabled={busy}
          />
          <div className="mt-2.5 flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleReset}
                disabled={busy || messages.length === 0}
                className="h-7 gap-1.5 px-2.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                <RefreshCcw className="h-3 w-3" />
                Reiniciar
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="h-7 gap-1.5 px-2.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                <Paperclip className="h-3 w-3" />
                Adjuntar
              </Button>
            </div>
            <div className="flex items-center gap-1.5">
              {busy && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={stop}
                  className="h-7 gap-1.5 px-3 text-[10px]"
                >
                  <Square className="h-3 w-3 fill-current" />
                  Detener
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                onClick={handleSend}
                disabled={
                  busy ||
                  attachments.some((a) => a.status === "processing") ||
                  (!input.trim() && !attachments.some((a) => a.status === "ready"))
                }
                className="h-7 gap-1.5 px-3 text-[10px]"
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
                {!busy && "Enviar"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <ChartDrillDrawer
        drill={chartDrill}
        onDrillChange={setChartDrill}
        contacts={dataset.contacts}
        tasks={dataset.tasks}
        calls={dataset.calls}
        allOpportunities={dataset.opportunities}
        allPautas={dataset.pautas}
        appointments={dataset.appointments}
        messages={dataset.messages}
        locationId={locationId ?? ""}
      />
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

function ConvEmptyState({ onSuggest }: { onSuggest: (s: string) => void }) {
  return (
    <div className="flex flex-col gap-5 py-2">
      <div className="space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Sugerencias
        </p>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.title}
                type="button"
                onClick={() => onSuggest(s.prompt)}
                className="group relative flex flex-col gap-2 rounded-xl border border-border/40 bg-muted/15 p-3.5 text-left transition-all hover:border-primary/40 hover:bg-muted/30"
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary/70 transition-colors group-hover:bg-primary/15 group-hover:text-primary">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60 transition-colors group-hover:text-primary/70">
                    {s.category}
                  </span>
                  <ArrowUpRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/25 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary/70" />
                </div>
                <div className="space-y-1">
                  <p className="text-[13px] font-medium leading-tight text-foreground/85 transition-colors group-hover:text-foreground">
                    {s.title}
                  </p>
                  <p className="text-[11px] leading-snug text-muted-foreground/55">
                    {s.prompt}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground/40">
        Contactos, citas, oportunidades, tareas y notas se consultan en vivo.
        Conversaciones reales, no muestras. Además puede generar reportes en PDF
        con el branding de Lezgo Suite, crear gráficos interactivos y tablas, y
        exportar CSVs.
      </p>
    </div>
  );
}

function ConvMessageBubble({
  message,
  onDrill,
}: {
  message: UIMessage;
  onDrill?: (title: string, contactIds: string[]) => void;
}) {
  const textBlocks = message.blocks.filter(
    (b): b is TextBlock => b.type === "text"
  );
  // Attachment-derived blocks: images/documents, plus text blocks the composer
  // generated for tabular/PDF attachments (recognized by their stable prefix).
  // These render as compact chips, never as message bubbles.
  const isAttachmentText = (t: string) =>
    t.startsWith(TABLE_SUMMARY_PREFIX) || t.startsWith(PDF_TEXT_PREFIX);
  const attachmentChips: Array<{ key: string; icon: "image" | "pdf" | "table"; label: string }> = [];
  for (const [i, b] of message.blocks.entries()) {
    if (b.type === "image") attachmentChips.push({ key: `a-${i}`, icon: "image", label: "Imagen" });
    else if (b.type === "document") attachmentChips.push({ key: `a-${i}`, icon: "pdf", label: "PDF" });
    else if (b.type === "text" && isAttachmentText(b.text))
      attachmentChips.push({
        key: `a-${i}`,
        icon: b.text.startsWith(PDF_TEXT_PREFIX) ? "pdf" : "table",
        label: b.text.startsWith(PDF_TEXT_PREFIX) ? "PDF" : "Datos",
      });
  }
  const visibleTextBlocks = textBlocks.filter((b) => !isAttachmentText(b.text));
  const toolUseBlocks = message.blocks.filter(
    (b): b is ToolUseBlock => b.type === "tool_use"
  );
  const chartBlocks = toolUseBlocks.filter((b) => b.name === "render_chart");
  const otherToolBlocks = toolUseBlocks.filter((b) => b.name !== "render_chart");
  const toolResultBlocks = message.blocks.filter(
    (b): b is ToolResultBlock => b.type === "tool_result"
  );

  if (
    message.role === "user" &&
    toolResultBlocks.length > 0 &&
    textBlocks.length === 0
  ) {
    const errors = toolResultBlocks.filter((b) => b.is_error).length;
    const ok = toolResultBlocks.length - errors;
    return (
      <div className="flex items-center gap-1 self-start rounded-full border border-border/40 bg-muted/25 px-2 py-0.5 text-[10px] text-muted-foreground">
        <span className="opacity-50">↳</span>
        <span>
          {ok} resultado{ok !== 1 ? "s" : ""}
          {errors > 0 ? `, ${errors} error${errors !== 1 ? "es" : ""}` : ""}
        </span>
      </div>
    );
  }

  const isUser = message.role === "user";
  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        isUser ? "items-end" : "items-start"
      )}
    >
      {attachmentChips.length > 0 && (
        <div className={cn("flex flex-wrap gap-1.5", isUser ? "justify-end" : "justify-start")}>
          {attachmentChips.map((c) => (
            <div
              key={c.key}
              className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground"
            >
              {c.icon === "image" ? (
                <ImageIcon className="h-3 w-3" />
              ) : c.icon === "pdf" ? (
                <FileText className="h-3 w-3" />
              ) : (
                <FileSpreadsheet className="h-3 w-3" />
              )}
              <span>{c.label}</span>
            </div>
          ))}
        </div>
      )}
      {visibleTextBlocks.map((b, i) => (
        <div
          key={`t-${i}`}
          className={cn(
            "max-w-[85%] rounded-2xl px-4 py-3 text-sm",
            isUser
              ? "bg-primary/90 text-primary-foreground"
              : "bg-muted/40 text-foreground ring-1 ring-inset ring-border/25"
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap">{b.text}</p>
          ) : (
            <div
              className={cn(
                "prose prose-sm dark:prose-invert max-w-none",
                "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
                "prose-p:my-2 prose-headings:mt-3 prose-headings:mb-1.5 prose-headings:font-semibold",
                "prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5",
                "prose-table:my-2 prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-th:bg-muted/50 prose-td:px-2 prose-td:py-1",
                "prose-code:rounded prose-code:bg-background/60 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none",
                "prose-strong:text-foreground prose-a:text-primary"
              )}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{b.text}</ReactMarkdown>
            </div>
          )}
        </div>
      ))}
      {chartBlocks.map((b, i) => {
        const spec = parseChartSpec(b.input);
        if (!spec) return null;
        return (
          <div key={`chart-${i}`} className="w-full">
            <ChatChart spec={spec} onDrill={onDrill} />
          </div>
        );
      })}
      {otherToolBlocks.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {Object.entries(
            otherToolBlocks.reduce<Record<string, number>>((acc, b) => {
              acc[b.name] = (acc[b.name] ?? 0) + 1;
              return acc;
            }, {})
          ).map(([name, count]) => (
            <div
              key={name}
              className="flex items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              <Wrench className="h-2.5 w-2.5 shrink-0" />
              <span className="font-medium text-foreground/70">{name}</span>
              {count > 1 && (
                <span className="rounded-full bg-border/70 px-1 font-mono leading-tight">
                  ×{count}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
