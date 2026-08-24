---
name: ai-assistant
description: How the "Asistente IA" tab works — the browser-side agent loop, the ~25 tools in lib/ai-tools.ts, the Spanish system prompt's hard-won rules, prompt caching, timezone handling, and the PDF/CSV/Excel attachment pipeline. Use when touching app/api/chat, hooks/use-agent-loop.ts, lib/ai-tools.ts, lib/ai-context.ts, lib/ai-index.ts, lib/conversations-panel.ts, conversations-chat.tsx, lib/attachments.ts, or app/api/attachments/process.
---

# AI assistant

The assistant is an **agent loop that runs in the browser**, not on the server.

- `app/api/chat/route.ts` handles exactly **one Anthropic turn per request**. When the
  model returns `tool_use` blocks the server just returns them; `hooks/use-agent-loop.ts`
  executes the tools locally and POSTs back with `tool_result` blocks. The server holds
  **no session state** between turns.
- `lib/ai-tools.ts` — the ~25 `TOOL_DEFINITIONS` and their executor. Most tools
  (`search_*`, `aggregate`, `relate`, `get_*`) run **against the dataset the browser
  already holds** — no extra GHL calls. The exceptions reach back through
  `lib/ghl-fetchers.ts` for data not in the initial sync: `get_contact_messages`,
  `search_conversations`, `get_contact_tasks`, `get_contact_notes`.
- UI-side tools: `render_chart` → `chat-chart.tsx`, `ask_user` → `chat-question.tsx`,
  `show_in_panel` → the conversations context panel, `create_pdf` / `export_csv` →
  direct browser downloads.
- `lib/conversations-panel.ts` holds the context panel's logic (extracted from the
  component so it stays testable-by-inspection): the **urgency buckets** are derived from
  the last message only — inbound and unanswered for >72 h = `red`, 24–72 h = `yellow`,
  under 24 h = `grey`; anything the team already replied to is `grey`. Contacts sort by
  bucket, then oldest-activity-first inside a bucket.
- `lib/ai-context.ts` — the Spanish system prompt. It carries hard-won behavioral rules
  (date-window consistency, never concluding from a truncated message sample, `lostReason`
  being a native field, never printing IDs). **Treat those numbered rules as regression
  fixes, not prose** — each one exists because the model got it wrong. Don't trim them
  for brevity.
- `lib/ai-index.ts` — `buildChatIndex()` precomputes the by-contact lookup maps
  (`oppsByContact`, `pautasByContact`, `pautaNameByContact`, …), cached on the contacts
  array reference so it survives within a single agent run.
- `datasetSummary` is built once on the client and pinned for **prompt caching**; keep
  it stable across turns in a session or the cache key breaks.
- **Timezone**: the browser's IANA zone is posted as `userTimezone` on every `chat` and
  `analyze-contact` call; both routes fall back to `America/Mexico_City`. Dates rendered
  into a prompt must go through that zone — the server runs in UTC on Vercel, so
  formatting a timestamp without it shifts "yesterday" by a day for the client.

## File attachments

Users can drop PDF / CSV / Excel files into the assistant composer.

- `app/api/attachments/process/route.ts` parses uploads server-side (`unpdf` for PDF,
  `xlsx` for tabular) into `ProcessedAttachment` objects. It touches no GHL. Limits:
  32 MB PDF, 25 MB tabular; each Excel sheet becomes its own table.
- **PDF text-vs-visual fallback**: if extracted text is under `MIN_PDF_TEXT` (40
  non-whitespace chars) the PDF is assumed scanned and re-sent as a native base64
  document block for Claude to read visually, instead of as text.
- **Tabular files are never pasted into the prompt.** Only a summary (schema, row count,
  8 sample rows, per-column stats from `buildTableSummary`) goes to the model; the full
  rows stay in the browser in `uploadedTablesRef` (`hooks/use-agent-loop.ts`) and are
  queried through the `list_uploaded_files` / `query_uploaded_table` /
  `join_uploaded_table` tools, executed locally by `lib/attachment-tools.ts`. Keep it that
  way — a spreadsheet inlined into the prompt blows the context and the cache.
- `lib/attachments.ts` stays framework-free (shared by the route and the verify script);
  the client-only file reading lives in the composer.
