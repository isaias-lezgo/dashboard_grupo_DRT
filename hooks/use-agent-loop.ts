"use client";

import { useCallback, useRef, useState } from "react";
import {
  executeTool,
  executeExportCsv,
  type ChatDataset,
} from "@/lib/ai-tools";
import { executeUploadedTableTool } from "@/lib/attachment-tools";
import type { UploadedTable } from "@/lib/attachments";
import {
  fetchContactMessages,
  fetchConversationThreads,
  fetchContactTasks,
  fetchContactNotes,
} from "@/lib/ghl-fetchers";
import { triggerDownload } from "@/lib/download";
import { downloadPdf } from "@/lib/pdf/build-pdf";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export interface DocumentBlock {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
}
export type AnyBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | DocumentBlock;

export interface ApiMessage {
  role: "user" | "assistant";
  content: AnyBlock[];
}

export interface UIMessage {
  role: "user" | "assistant";
  blocks: AnyBlock[];
}

export interface QuestionOption {
  label: string;
  value?: string;
  hint?: string;
}
export interface PendingQuestion {
  toolUseId: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  context?: string;
}
export type AnswerPayload =
  | { values: string[]; labels?: string[] }
  | { text: string };

// What the composer hands to send(): content blocks to append to the user
// message, plus any tabular files to register for the query/join tools.
export interface ReadyAttachment {
  blocks: Array<ImageBlock | DocumentBlock | TextBlock>;
  tables?: UploadedTable[];
}

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_TURNS = 15;
const PRICING = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
};

function estimateCost(u: TurnUsage): number {
  return (
    (u.inputTokens * PRICING.input +
      u.outputTokens * PRICING.output +
      u.cacheReadTokens * PRICING.cacheRead +
      u.cacheCreationTokens * PRICING.cacheWrite) /
    1_000_000
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface AgentLoopOptions {
  datasetSummary: string;
  dataset: ChatDataset;
  onToolExecuted?: (
    name: string,
    input: Record<string, unknown>,
    result: unknown
  ) => void;
}

export interface AgentLoopReturn {
  messages: UIMessage[];
  busy: boolean;
  status: string | null;
  error: string | null;
  totalCost: number;
  totalTools: number;
  send: (text: string, attachments?: ReadyAttachment[]) => void;
  stop: () => void;
  reset: () => void;
  runWithMessages: (msgs: UIMessage[]) => void;
  pendingQuestion: PendingQuestion | null;
  answer: (payload: AnswerPayload) => void;
}

export function useAgentLoop({
  datasetSummary,
  dataset,
  onToolExecuted,
}: AgentLoopOptions): AgentLoopReturn {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totalCost, setTotalCost] = useState(0);
  const [totalTools, setTotalTools] = useState(0);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const pauseStashRef = useRef<{
    convo: UIMessage[];
    partialResults: ToolResultBlock[];
    askToolUseId: string;
  } | null>(null);

  const stopRef = useRef(false);
  const messagesRef = useRef<UIMessage[]>([]);
  const uploadedTablesRef = useRef<UploadedTable[]>([]);
  // Always use the latest callback without re-creating runWithMessages
  const onToolExecutedRef = useRef(onToolExecuted);
  onToolExecutedRef.current = onToolExecuted;

  const runWithMessages = useCallback(
    async (initialMessages: UIMessage[]) => {
      stopRef.current = false;
      setBusy(true);
      setError(null);
      let convo = [...initialMessages];

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          if (stopRef.current) break;
          setStatus(turn === 0 ? "Pensando…" : "Continuando…");

          const apiMessages: ApiMessage[] = convo.map((m) => ({
            role: m.role,
            content: m.blocks,
          }));

          const userTimezone =
            Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Mexico_City";

          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ datasetSummary, messages: apiMessages, userTimezone }),
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(
              (errData as { error?: string }).error || `HTTP ${res.status}`
            );
          }

          const data = (await res.json()) as {
            stopReason: string;
            content: AnyBlock[];
            usage: TurnUsage;
          };

          setTotalCost((c) => c + estimateCost(data.usage));

          const assistantMsg: UIMessage = {
            role: "assistant",
            blocks: data.content,
          };
          convo = [...convo, assistantMsg];
          setMessages(convo);
          messagesRef.current = convo;

          const toolUses = data.content.filter(
            (b): b is ToolUseBlock => b.type === "tool_use"
          );

          if (toolUses.length === 0) {
            if (data.stopReason === "max_tokens") {
              convo = [
                ...convo,
                {
                  role: "user",
                  blocks: [{ type: "text", text: "Continúa." }],
                },
              ];
              setMessages(convo);
              messagesRef.current = convo;
              continue;
            }
            break;
          }

          setStatus(
            toolUses.length === 1
              ? `Ejecutando ${toolUses[0].name}…`
              : `Ejecutando ${toolUses.length} herramientas…`
          );

          // A clarifying question pauses the loop. Run any sibling tools so their
          // results are ready for the resume, but hold the request until the user
          // answers (the model is told to call ask_user alone, so toRun is usually
          // empty here).
          const askUse = toolUses.find((b) => b.name === "ask_user");
          const toRun = askUse
            ? toolUses.filter((b) => b.name !== "ask_user")
            : toolUses;

          const toolResults: ToolResultBlock[] = await Promise.all(
            toRun.map(async (tu): Promise<ToolResultBlock> => {
              try {
                let result: unknown;
                if (tu.name === "get_contact_messages") {
                  result = await fetchContactMessages(tu.input);
                } else if (tu.name === "search_conversations") {
                  result = await fetchConversationThreads(tu.input);
                } else if (tu.name === "get_contact_tasks") {
                  result = await fetchContactTasks(tu.input);
                } else if (tu.name === "get_contact_notes") {
                  result = await fetchContactNotes(tu.input);
                } else if (tu.name === "export_csv") {
                  const exportResult = executeExportCsv(tu.input, dataset);
                  if (exportResult.rowCount > 0)
                    triggerDownload({
                      content: exportResult.csvContent,
                      filename: exportResult.filename,
                      mimeType: "text/csv;charset=utf-8;",
                    });
                  result = {
                    success: exportResult.rowCount > 0,
                    filename: exportResult.filename,
                    rowCount: exportResult.rowCount,
                  };
                } else if (tu.name === "create_pdf") {
                  result = await downloadPdf(tu.input);
                } else if (
                  tu.name === "list_uploaded_files" ||
                  tu.name === "query_uploaded_table" ||
                  tu.name === "join_uploaded_table"
                ) {
                  result = executeUploadedTableTool(
                    tu.name,
                    tu.input,
                    uploadedTablesRef.current,
                    dataset
                  );
                } else {
                  result = executeTool(tu.name, tu.input, dataset);
                }

                onToolExecutedRef.current?.(tu.name, tu.input, result);

                return {
                  type: "tool_result",
                  tool_use_id: tu.id,
                  content: JSON.stringify(result),
                };
              } catch (err) {
                return {
                  type: "tool_result",
                  tool_use_id: tu.id,
                  content: JSON.stringify({
                    error: err instanceof Error ? err.message : String(err),
                  }),
                  is_error: true,
                };
              }
            })
          );

          setTotalTools((n) => n + toRun.length);

          if (askUse) {
            const aInput = askUse.input as Record<string, unknown>;
            const rawOptions = Array.isArray(aInput.options)
              ? (aInput.options as unknown[])
              : [];
            const options: QuestionOption[] = rawOptions
              .filter(
                (o): o is Record<string, unknown> =>
                  Boolean(o) && typeof o === "object",
              )
              .map((o) => ({
                label: String(o.label ?? ""),
                value: o.value !== undefined ? String(o.value) : undefined,
                hint: o.hint !== undefined ? String(o.hint) : undefined,
              }))
              .filter((o) => o.label);
            pauseStashRef.current = {
              convo,
              partialResults: toolResults,
              askToolUseId: askUse.id,
            };
            setPendingQuestion({
              toolUseId: askUse.id,
              question: String(aInput.question ?? ""),
              options,
              multiSelect: aInput.multiSelect === true,
              context:
                typeof aInput.context === "string" ? aInput.context : undefined,
            });
            setBusy(false);
            setStatus(null);
            return;
          }

          convo = [...convo, { role: "user", blocks: toolResults }];
          setMessages(convo);
          messagesRef.current = convo;
        }

        const lastAssistant = [...convo]
          .reverse()
          .find((m) => m.role === "assistant");
        const hasText = lastAssistant?.blocks.some(
          (b) => b.type === "text" && (b as TextBlock).text.trim()
        );
        if (!hasText) {
          const notice: UIMessage = {
            role: "assistant",
            blocks: [
              {
                type: "text",
                text: "⚠️ El agente alcanzó el límite de turnos sin producir una respuesta completa. Intenta hacer una pregunta más específica.",
              },
            ],
          };
          const final = [...convo, notice];
          setMessages(final);
          messagesRef.current = final;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error desconocido");
      } finally {
        setBusy(false);
        setStatus(null);
      }
    },
    [datasetSummary, dataset]
  );

  const answer = useCallback(
    (payload: AnswerPayload) => {
      const stash = pauseStashRef.current;
      if (!stash) return;

      const summary =
        "values" in payload
          ? (payload.labels ?? payload.values).join(", ")
          : payload.text;
      const askResult: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: stash.askToolUseId,
        content:
          "values" in payload
            ? JSON.stringify({ answer: payload.values })
            : JSON.stringify({ answer: payload.text, freeText: true }),
      };

      // The user message carries the tool_result blocks (sibling results + the
      // ask_user answer) FIRST — the Anthropic API requires tool_result blocks to
      // precede any other content — followed by a visible text bubble with the
      // chosen answer. Every prior tool_use stays paired with a tool_result.
      const userMsg: UIMessage = {
        role: "user",
        blocks: [
          ...stash.partialResults,
          askResult,
          { type: "text", text: summary },
        ],
      };
      const resumed = [...stash.convo, userMsg];

      pauseStashRef.current = null;
      setPendingQuestion(null);
      setMessages(resumed);
      messagesRef.current = resumed;
      void runWithMessages(resumed);
    },
    [runWithMessages],
  );

  const send = useCallback(
    (text: string, attachments?: ReadyAttachment[]) => {
      if (busy) return;
      // If a clarifying question is open, route the typed text as its answer so
      // the pending ask_user tool_use gets a matching tool_result.
      if (pauseStashRef.current) {
        answer({ text });
        return;
      }
      // Register any tabular files so the query/join tools can see them.
      const newTables = (attachments ?? []).flatMap((a) => a.tables ?? []);
      if (newTables.length > 0) {
        uploadedTablesRef.current = [...uploadedTablesRef.current, ...newTables];
      }
      // Attachment blocks come FIRST, then the visible text.
      const attachmentBlocks = (attachments ?? []).flatMap((a) => a.blocks);
      const blocks: AnyBlock[] = [...attachmentBlocks];
      if (text) blocks.push({ type: "text", text });
      if (blocks.length === 0) return;

      const userMsg: UIMessage = { role: "user", blocks };
      const next = [...messagesRef.current, userMsg];
      setMessages(next);
      messagesRef.current = next;
      void runWithMessages(next);
    },
    [busy, runWithMessages, answer]
  );

  const stop = useCallback(() => {
    stopRef.current = true;
  }, []);

  const reset = useCallback(() => {
    setMessages([]);
    messagesRef.current = [];
    setError(null);
    setStatus(null);
    setTotalCost(0);
    setTotalTools(0);
    setPendingQuestion(null);
    pauseStashRef.current = null;
    uploadedTablesRef.current = [];
  }, []);

  return {
    messages,
    busy,
    status,
    error,
    totalCost,
    totalTools,
    send,
    stop,
    reset,
    runWithMessages,
    pendingQuestion,
    answer,
  };
}
