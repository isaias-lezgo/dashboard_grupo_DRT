// Builds exportable transcripts of an "Asistente IA" conversation from the
// in-memory UIMessage[] held by useAgentLoop. Two formats:
//   - Markdown: human-readable review copy (prompts, AI responses, tool calls
//     with full inputs + full raw results, in order).
//   - JSON: lossless structured dump of every message block + metadata.
//
// Pure functions, no React — kept separate so the transcript shape can be
// reasoned about and changed without touching the chat component.

import type {
  UIMessage,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "@/hooks/use-agent-loop";

export interface ChatExportMeta {
  exportedAt: Date;
  model: string;
  totalCost: number;
  totalTools: number;
}

// Pretty-print a JSON-ish value for a fenced code block. Tool results arrive as
// strings (already JSON.stringify'd); re-parse so we can re-indent them, but
// fall back to the raw string if it isn't valid JSON.
function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Local-time stamp for filenames, e.g. 20260607-1432.
export function exportTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

export function buildChatMarkdown(
  messages: UIMessage[],
  meta: ChatExportMeta
): string {
  const lines: string[] = [];

  lines.push("# Chat con Asistente IA");
  lines.push("");
  lines.push(`- **Exportado:** ${meta.exportedAt.toLocaleString()}`);
  lines.push(`- **Modelo:** ${meta.model}`);
  lines.push(`- **Herramientas usadas:** ${meta.totalTools}`);
  lines.push(`- **Costo estimado:** ~$${meta.totalCost.toFixed(4)}`);
  lines.push(`- **Mensajes:** ${messages.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "text") {
        const b = block as TextBlock;
        const text = b.text.trim();
        if (!text) continue;
        lines.push(message.role === "user" ? "### 🧑 Tú" : "### 🤖 Asistente");
        lines.push("");
        lines.push(text);
        lines.push("");
      } else if (block.type === "tool_use") {
        const b = block as ToolUseBlock;
        lines.push(`#### 🔧 Herramienta: \`${b.name}\``);
        lines.push("");
        lines.push("_Entrada:_");
        lines.push("");
        lines.push("```json");
        lines.push(prettyJson(b.input));
        lines.push("```");
        lines.push("");
      } else if (block.type === "tool_result") {
        const b = block as ToolResultBlock;
        lines.push(b.is_error ? "_↳ Resultado (⚠️ error):_" : "_↳ Resultado:_");
        lines.push("");
        lines.push("```json");
        lines.push(prettyJson(b.content));
        lines.push("```");
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

export function buildChatJson(
  messages: UIMessage[],
  meta: ChatExportMeta
): string {
  return JSON.stringify(
    {
      meta: {
        exportedAt: meta.exportedAt.toISOString(),
        model: meta.model,
        totalCost: meta.totalCost,
        totalTools: meta.totalTools,
        messageCount: messages.length,
      },
      messages,
    },
    null,
    2
  );
}
