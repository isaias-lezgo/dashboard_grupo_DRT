# AI Assistant File Attachments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the "Asistente IA" chat accept image, PDF, CSV and Excel attachments, pre-processed for minimal token cost, with tabular files queryable by the agent's tools and cross-referenceable against CRM data.

**Architecture:** PDFs and spreadsheets are parsed **server-side** in a new `/api/attachments/process` route (Node: `unpdf` + `xlsx`), which returns normalized `ProcessedAttachment` objects. Images are validated and base64-encoded **client-side** (no library). Each attachment becomes Anthropic content blocks in the user message: images → `image` blocks, text-PDFs → `text`, scanned-PDFs → `document` blocks, spreadsheets → a compact `text` **summary** (schema + sample + stats). The spreadsheet's **full rows** stay client-side in a ref keyed by `fileId`, and three new tools (`list_uploaded_files`, `query_uploaded_table`, `join_uploaded_table`) query them — the join tool cross-references against the in-memory `ChatDataset`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Anthropic SDK, `xlsx` (SheetJS), `unpdf`, React client components. No test framework — pure modules get `scripts/verify-*.ts` assertion scripts run via `tsx`; UI/route verified by driving the app.

## Global Constraints

- Package is **CommonJS** (no `"type":"module"`): in `scripts/verify-*.ts`, top-level `await` fails — wrap async in `main()` and call `main().catch(...)`.
- Installing anything needs `npm install --legacy-peer-deps`.
- `npx tsc --noEmit` is the REQUIRED build gate — `next build` ignores TS errors, so a green build proves nothing.
- The chat model `claude-sonnet-4-6` already supports vision and documents — **do not change the model**.
- **Brand rule:** never emit "GoHighLevel"/"GHL"; the platform is "Lezgo Suite CRM". (Relevant only if writing user-facing copy.)
- The processing route touches **no GHL** — it needs only the middleware gate, NOT `requireClient()`/`withClient()` (same as `/api/chat`).
- Never print raw contact/opportunity/pipeline IDs in model-facing tool output that the model might echo — follow the existing `compact*` conventions.
- Size limits: image ≤ 5 MB, PDF ≤ 32 MB, spreadsheet warns above 50,000 rows.

---

## File Structure

- **Create** `lib/attachments.ts` — shared types (`ProcessedAttachment`, `UploadedTable`, `ColumnInfo`, `ColumnStats`, `ReadyAttachment`) + pure helpers: `inferColumnType`, `buildTableSummary`, `formatTableSummaryText`, `parseDelimited` is NOT here (server uses xlsx). Client-only helpers: `validateFile`, `fileToBase64`, `imageToBlock`.
- **Create** `lib/attachment-tools.ts` — `executeUploadedTableTool(name, input, tables, data)` implementing `list_uploaded_files`, `query_uploaded_table`, `join_uploaded_table` over `UploadedTable[]` + `ChatDataset`.
- **Create** `app/api/attachments/process/route.ts` — Node route; `unpdf` for PDF text (visual fallback), `xlsx` for CSV/Excel; returns `ProcessedAttachment[]`.
- **Create** `scripts/verify-attachments.ts` — `node:assert/strict` assertions for the pure logic in `lib/attachments.ts` + `lib/attachment-tools.ts`.
- **Modify** `lib/ai-tools.ts` — add 3 tool schema objects to `TOOL_DEFINITIONS` (so `ToolName` includes them).
- **Modify** `hooks/use-agent-loop.ts` — `AnyBlock` gains `ImageBlock`/`DocumentBlock`; add `uploadedTablesRef`; `send(text, attachments?)`; register tables; route the 3 tool names to `executeUploadedTableTool`.
- **Modify** `components/dashboard/conversations-chat.tsx` — composer: attach button, drag-drop, paste, preview chips, processing state; call the process route; pass `ReadyAttachment[]` to `send`.
- **Modify** `lib/ai-context.ts` — add an "# Archivos adjuntos" section to `ASSISTANT_SYSTEM_PROMPT`.
- **Modify** `package.json` — `verify:attachments` script (deps added via npm install).

---

## Task 1: Shared attachment types & pure tabular helpers

**Files:**
- Create: `lib/attachments.ts`
- Create: `scripts/verify-attachments.ts`
- Modify: `package.json` (add `verify:attachments` script)
- Install: `xlsx`, `unpdf`

**Interfaces:**
- Produces:
  - `ColumnInfo = { name: string; type: "number" | "date" | "text" }`
  - `ColumnStats = { name: string; type: ColumnInfo["type"]; nonEmpty: number } & ({ min: number; max: number; sum: number; avg: number } | { top: Array<{ value: string; count: number }> } | {})`
  - `UploadedTable = { fileId: string; filename: string; sheetName?: string; schema: ColumnInfo[]; rowCount: number; rows: Array<Record<string, unknown>> }`
  - `ProcessedTable = { kind: "table"; filename: string; sheetName?: string; schema: ColumnInfo[]; rowCount: number; sampleRows: Array<Record<string, unknown>>; stats: ColumnStats[]; rows: Array<Record<string, unknown>> }`
  - `ProcessedAttachment = { kind: "pdf_text"; filename: string; text: string; pageCount: number } | { kind: "pdf_visual"; filename: string; mediaType: string; dataBase64: string } | ProcessedTable`
  - `inferColumnType(values: unknown[]): ColumnInfo["type"]`
  - `buildTableSummary(rows: Array<Record<string, unknown>>, opts: { sampleSize?: number }): { schema: ColumnInfo[]; stats: ColumnStats[]; sampleRows: Array<Record<string, unknown>> }`
  - `formatTableSummaryText(t: { fileId: string; filename: string; sheetName?: string; rowCount: number; schema: ColumnInfo[]; stats: ColumnStats[]; sampleRows: Array<Record<string, unknown>> }): string`

- [ ] **Step 1: Install the two libraries**

Run:
```bash
npm install --legacy-peer-deps xlsx unpdf
```
Expected: both added to `package.json` dependencies, no error (warnings OK).

- [ ] **Step 2: Create `lib/attachments.ts` with the pure helpers**

Create `lib/attachments.ts`:
```ts
// Shared attachment types + pure helpers. The pure parts (type inference,
// summary building, summary formatting) are asserted in scripts/verify-attachments.ts.
// Client-only helpers (file reading) live at the bottom and never run server-side.

export interface ColumnInfo {
  name: string;
  type: "number" | "date" | "text";
}

export type ColumnStats =
  | { name: string; type: "number"; nonEmpty: number; min: number; max: number; sum: number; avg: number }
  | { name: string; type: "date"; nonEmpty: number; min: string; max: string }
  | { name: string; type: "text"; nonEmpty: number; top: Array<{ value: string; count: number }> };

export interface UploadedTable {
  fileId: string;
  filename: string;
  sheetName?: string;
  schema: ColumnInfo[];
  rowCount: number;
  rows: Array<Record<string, unknown>>;
}

export interface ProcessedTable {
  kind: "table";
  filename: string;
  sheetName?: string;
  schema: ColumnInfo[];
  rowCount: number;
  sampleRows: Array<Record<string, unknown>>;
  stats: ColumnStats[];
  rows: Array<Record<string, unknown>>;
}

export type ProcessedAttachment =
  | { kind: "pdf_text"; filename: string; text: string; pageCount: number }
  | { kind: "pdf_visual"; filename: string; mediaType: string; dataBase64: string }
  | ProcessedTable;

const NUMERIC_RE = /^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.trim().replace(/,/g, "");
    if (s !== "" && NUMERIC_RE.test(v.trim())) {
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

// Infer a column's type from its non-empty values. A column is "number" if every
// non-empty value parses as a number, "date" if every non-empty value looks like
// an ISO-ish date, else "text". Empty columns default to "text".
export function inferColumnType(values: unknown[]): ColumnInfo["type"] {
  let seen = 0;
  let allNum = true;
  let allDate = true;
  for (const v of values) {
    if (isEmpty(v)) continue;
    seen++;
    if (toNum(v) === null) allNum = false;
    if (!(typeof v === "string" && DATE_RE.test(v.trim()))) allDate = false;
    if (!allNum && !allDate) break;
  }
  if (seen === 0) return "text";
  if (allNum) return "number";
  if (allDate) return "date";
  return "text";
}

function columnStats(name: string, type: ColumnInfo["type"], values: unknown[]): ColumnStats {
  const nonEmptyVals = values.filter((v) => !isEmpty(v));
  const nonEmpty = nonEmptyVals.length;
  if (type === "number") {
    const nums = nonEmptyVals.map((v) => toNum(v)).filter((n): n is number => n !== null);
    if (nums.length === 0) return { name, type, nonEmpty, min: 0, max: 0, sum: 0, avg: 0 };
    let min = nums[0], max = nums[0], sum = 0;
    for (const n of nums) { if (n < min) min = n; if (n > max) max = n; sum += n; }
    return { name, type, nonEmpty, min, max, sum, avg: sum / nums.length };
  }
  if (type === "date") {
    const strs = nonEmptyVals.map((v) => String(v).trim()).sort();
    return { name, type, nonEmpty, min: strs[0] ?? "", max: strs[strs.length - 1] ?? "" };
  }
  const counts = new Map<string, number>();
  for (const v of nonEmptyVals) {
    const k = String(v).trim();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const top = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([value, count]) => ({ value, count }));
  return { name, type, nonEmpty, top };
}

// Build schema + per-column stats + a small sample from parsed rows.
export function buildTableSummary(
  rows: Array<Record<string, unknown>>,
  opts: { sampleSize?: number } = {}
): { schema: ColumnInfo[]; stats: ColumnStats[]; sampleRows: Array<Record<string, unknown>> } {
  const sampleSize = opts.sampleSize ?? 8;
  const colNames: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); colNames.push(k); }
    }
  }
  const schema: ColumnInfo[] = [];
  const stats: ColumnStats[] = [];
  for (const name of colNames) {
    const values = rows.map((r) => r[name]);
    const type = inferColumnType(values);
    schema.push({ name, type });
    stats.push(columnStats(name, type, values));
  }
  return { schema, stats, sampleRows: rows.slice(0, sampleSize) };
}

// Format a compact Spanish summary block for the model. This is what goes into
// the user message as a text block — NOT the full rows.
export function formatTableSummaryText(t: {
  fileId: string;
  filename: string;
  sheetName?: string;
  rowCount: number;
  schema: ColumnInfo[];
  stats: ColumnStats[];
  sampleRows: Array<Record<string, unknown>>;
}): string {
  const header =
    `Archivo tabular adjunto — fileId: "${t.fileId}" · ${t.filename}` +
    (t.sheetName ? ` · hoja "${t.sheetName}"` : "") +
    ` · ${t.rowCount} filas.`;
  const cols = t.schema.map((c) => `${c.name} (${c.type})`).join(", ");
  const statLines = t.stats.map((s) => {
    if (s.type === "number") return `- ${s.name}: min ${s.min}, max ${s.max}, suma ${s.sum}, prom ${s.avg.toFixed(2)} (${s.nonEmpty} con valor)`;
    if (s.type === "date") return `- ${s.name}: de ${s.min} a ${s.max} (${s.nonEmpty} con valor)`;
    return `- ${s.name}: top ${s.top.map((x) => `${x.value} (${x.count})`).join(", ")}`;
  });
  const sample = JSON.stringify(t.sampleRows, null, 0);
  return [
    header,
    `Columnas: ${cols}`,
    `Estadísticas:`,
    ...statLines,
    `Muestra (primeras ${t.sampleRows.length} filas): ${sample}`,
    `Para consultar TODAS las filas usa query_uploaded_table / join_uploaded_table con fileId "${t.fileId}". La muestra y estadísticas de arriba NO son el total — no concluyas totales de la muestra.`,
  ].join("\n");
}
```

- [ ] **Step 3: Write the failing verify script**

Create `scripts/verify-attachments.ts`:
```ts
import assert from "node:assert/strict";
import {
  inferColumnType,
  buildTableSummary,
  formatTableSummaryText,
} from "../lib/attachments";

function main() {
  // inferColumnType
  assert.equal(inferColumnType(["1", "2", "3,000", ""]), "number");
  assert.equal(inferColumnType(["2026-01-01", "2026-07-22"]), "date");
  assert.equal(inferColumnType(["a", "b", "1"]), "text");
  assert.equal(inferColumnType([]), "text");

  // buildTableSummary
  const rows = [
    { email: "a@x.com", monto: "100", fecha: "2026-01-01" },
    { email: "b@x.com", monto: "300", fecha: "2026-02-01" },
    { email: "a@x.com", monto: "200", fecha: "2026-03-01" },
  ];
  const s = buildTableSummary(rows, { sampleSize: 2 });
  assert.deepEqual(s.schema.map((c) => c.type), ["text", "number", "date"]);
  assert.equal(s.sampleRows.length, 2);
  const montoStat = s.stats.find((x) => x.name === "monto");
  assert.ok(montoStat && montoStat.type === "number");
  if (montoStat.type === "number") {
    assert.equal(montoStat.sum, 600);
    assert.equal(montoStat.min, 100);
    assert.equal(montoStat.max, 300);
    assert.equal(montoStat.avg, 200);
  }
  const emailStat = s.stats.find((x) => x.name === "email");
  assert.ok(emailStat && emailStat.type === "text");
  if (emailStat.type === "text") {
    assert.equal(emailStat.top[0].value, "a@x.com");
    assert.equal(emailStat.top[0].count, 2);
  }

  // formatTableSummaryText includes the fileId and does not leak all rows
  const text = formatTableSummaryText({ fileId: "F1", filename: "ventas.csv", rowCount: 3, ...s });
  assert.ok(text.includes('fileId: "F1"'));
  assert.ok(text.includes("query_uploaded_table"));
  assert.ok(!text.includes("2026-03-01")); // 3rd row not in the 2-row sample

  console.log("verify-attachments (Task 1): OK");
}

main();
```

- [ ] **Step 4: Add the npm script**

In `package.json` `scripts`, add after `"verify:limiter"`:
```json
"verify:attachments": "tsx scripts/verify-attachments.ts",
```

- [ ] **Step 5: Run the verify script**

Run:
```bash
npm run verify:attachments
```
Expected: `verify-attachments (Task 1): OK`

- [ ] **Step 6: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/attachments.ts scripts/verify-attachments.ts package.json package-lock.json
git commit -m "feat(attachments): shared types + pure tabular summary helpers"
```

---

## Task 2: Uploaded-table tools (schemas + executor)

**Files:**
- Create: `lib/attachment-tools.ts`
- Modify: `lib/ai-tools.ts` (add 3 objects to `TOOL_DEFINITIONS`, near the end before `ask_user`)
- Modify: `scripts/verify-attachments.ts` (extend with tool assertions)

**Interfaces:**
- Consumes: `UploadedTable`, `ColumnInfo` (from `lib/attachments.ts`); `ChatDataset` (from `lib/ai-tools.ts`).
- Produces: `executeUploadedTableTool(name: string, input: Record<string, unknown>, tables: UploadedTable[], data: ChatDataset): unknown`
- Tool names added to `TOOL_DEFINITIONS`: `list_uploaded_files`, `query_uploaded_table`, `join_uploaded_table`.

- [ ] **Step 1: Add the 3 tool schemas to `TOOL_DEFINITIONS`**

In `lib/ai-tools.ts`, insert these three objects into the `TOOL_DEFINITIONS` array immediately **before** the `ask_user` object (around line 611):
```ts
  {
    name: "list_uploaded_files",
    description:
      "Lists the tabular files (CSV/Excel) the user has attached in this conversation, with their fileId, filename, row count and column schema. Call this first when the user refers to 'el archivo', 'el Excel', 'el CSV' or 'los datos que subí' and you need the fileId to query it. Images and PDFs are already visible in the message and are NOT listed here.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "query_uploaded_table",
    description:
      "Queries the FULL rows of one attached tabular file (not just the sample shown in the message). Use for any question about the file's own content: filtering, counting, summing, averaging, grouping, or listing rows. Get the fileId from list_uploaded_files or from the attachment summary in the message.",
    input_schema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file to query (from list_uploaded_files)." },
        filter: {
          type: "object",
          additionalProperties: true,
          description:
            "Optional exact-match filters, keyed by column name: { \"Estado\": \"Activo\" }. Case-insensitive equality on the string form of each cell. Multiple keys are AND'd.",
        },
        groupBy: { type: "string", description: "Optional column to group by. Omit for a single total." },
        metric: { type: "string", enum: ["count", "sum", "avg"], description: "Aggregation. Default count. sum/avg require metricColumn." },
        metricColumn: { type: "string", description: "Numeric column for sum/avg." },
        columns: { type: "array", items: { type: "string" }, description: "Optional projection for the returned sample rows." },
        limit: { type: "number", description: "Max sample rows / groups to return (default 25, max 100)." },
      },
      required: ["fileId"],
    },
  },
  {
    name: "join_uploaded_table",
    description:
      "Cross-references a column of an attached tabular file against the CRM's contacts or opportunities, in ONE call. Use for questions like 'de estos emails del Excel, cuáles ya son contactos' or 'estos teléfonos, cuáles no están en el CRM'. Returns matched/unmatched counts and a capped sample. Resolve names via search_contacts if you need to display them.",
    input_schema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The attached file (from list_uploaded_files)." },
        tableColumn: { type: "string", description: "Column in the file to match on (e.g. 'email', 'telefono')." },
        entity: { type: "string", enum: ["contacts", "opportunities"], description: "CRM entity to match against." },
        entityField: {
          type: "string",
          description:
            "Field on the CRM entity to match. Contacts: 'email' | 'phone' | 'name' | 'id'. Opportunities: 'name' | 'contactId' | 'id'.",
        },
        mode: { type: "string", enum: ["matched", "unmatched", "both"], description: "Which table rows to report. Default 'both'." },
        limit: { type: "number", description: "Max sample rows per bucket (default 25, max 100)." },
      },
      required: ["fileId", "tableColumn", "entity", "entityField"],
    },
  },
```

- [ ] **Step 2: Create the executor `lib/attachment-tools.ts`**

Create `lib/attachment-tools.ts`:
```ts
// Executor for the uploaded-file tools. Runs client-side (in the agent loop),
// like the rest of lib/ai-tools.ts. Operates over the session's UploadedTable[]
// and, for joins, the in-memory ChatDataset. Pure — asserted in
// scripts/verify-attachments.ts.

import type { ChatDataset } from "@/lib/ai-tools";
import type { UploadedTable } from "@/lib/attachments";

type ToolInput = Record<string, unknown>;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function clampLimit(n: unknown, def = DEFAULT_LIMIT): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : def;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(v)));
}

function norm(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function cell(row: Record<string, unknown>, col: string): unknown {
  if (col in row) return row[col];
  const target = col.trim().toLowerCase();
  for (const k of Object.keys(row)) if (k.toLowerCase() === target) return row[k];
  return undefined;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.trim().replace(/,/g, "");
    const n = Number(s);
    return s !== "" && Number.isFinite(n) ? n : null;
  }
  return null;
}

function findTable(tables: UploadedTable[], fileId: unknown): UploadedTable | undefined {
  return tables.find((t) => t.fileId === String(fileId));
}

function listUploadedFiles(tables: UploadedTable[]) {
  return {
    files: tables.map((t) => ({
      fileId: t.fileId,
      filename: t.filename,
      sheetName: t.sheetName,
      rowCount: t.rowCount,
      columns: t.schema.map((c) => `${c.name} (${c.type})`),
    })),
  };
}

function queryUploadedTable(input: ToolInput, tables: UploadedTable[]) {
  const table = findTable(tables, input.fileId);
  if (!table) return { error: `No hay archivo con fileId "${String(input.fileId)}"` };
  const limit = clampLimit(input.limit);

  let rows = table.rows;
  const filter = input.filter && typeof input.filter === "object" ? (input.filter as Record<string, unknown>) : {};
  const filterEntries = Object.entries(filter);
  if (filterEntries.length > 0) {
    rows = rows.filter((r) => filterEntries.every(([col, want]) => norm(cell(r, col)) === norm(want)));
  }

  const metric = input.metric === "sum" || input.metric === "avg" ? input.metric : "count";
  const metricColumn = typeof input.metricColumn === "string" ? input.metricColumn : undefined;
  const groupBy = typeof input.groupBy === "string" && input.groupBy ? input.groupBy : undefined;

  const agg = (subset: Record<string, unknown>[]): { count: number; sum?: number; avg?: number } => {
    if (metric === "count" || !metricColumn) return { count: subset.length };
    let sum = 0, seen = 0;
    for (const r of subset) { const n = toNum(cell(r, metricColumn)); if (n !== null) { sum += n; seen++; } }
    return metric === "sum" ? { count: subset.length, sum } : { count: subset.length, avg: seen ? sum / seen : 0 };
  };

  if (groupBy) {
    const buckets = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const key = String(cell(r, groupBy) ?? "(sin valor)");
      const b = buckets.get(key); if (b) b.push(r); else buckets.set(key, [r]);
    }
    const groups = Array.from(buckets.entries())
      .map(([key, subset]) => ({ key, ...agg(subset) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
    return { rowCount: rows.length, groups };
  }

  const cols = Array.isArray(input.columns) ? (input.columns as string[]) : null;
  const project = (r: Record<string, unknown>) =>
    cols ? Object.fromEntries(cols.map((c) => [c, cell(r, c)])) : r;
  return {
    rowCount: rows.length,
    ...agg(rows),
    sample: rows.slice(0, limit).map(project),
  };
}

function joinUploadedTable(input: ToolInput, tables: UploadedTable[], data: ChatDataset) {
  const table = findTable(tables, input.fileId);
  if (!table) return { error: `No hay archivo con fileId "${String(input.fileId)}"` };
  const tableColumn = String(input.tableColumn ?? "");
  const entity = input.entity === "opportunities" ? "opportunities" : "contacts";
  const entityField = String(input.entityField ?? "");
  const mode = input.mode === "matched" || input.mode === "unmatched" ? input.mode : "both";
  const limit = clampLimit(input.limit);

  const crmValue = (rec: Record<string, unknown>): unknown => rec[entityField];
  const crmRecords: Record<string, unknown>[] =
    entity === "opportunities" ? (data.opportunities as unknown as Record<string, unknown>[]) : (data.contacts as unknown as Record<string, unknown>[]);
  const crmSet = new Set<string>();
  for (const rec of crmRecords) {
    const v = crmValue(rec);
    if (v !== undefined && v !== null && String(v).trim() !== "") crmSet.add(norm(v));
  }

  const matched: Record<string, unknown>[] = [];
  const unmatched: Record<string, unknown>[] = [];
  for (const r of table.rows) {
    const key = norm(cell(r, tableColumn));
    if (key === "") continue;
    (crmSet.has(key) ? matched : unmatched).push(r);
  }

  const out: Record<string, unknown> = {
    entity,
    entityField,
    tableColumn,
    matchedCount: matched.length,
    unmatchedCount: unmatched.length,
  };
  if (mode !== "unmatched") out.matchedSample = matched.slice(0, limit);
  if (mode !== "matched") out.unmatchedSample = unmatched.slice(0, limit);
  return out;
}

export function executeUploadedTableTool(
  name: string,
  input: ToolInput,
  tables: UploadedTable[],
  data: ChatDataset
): unknown {
  switch (name) {
    case "list_uploaded_files":
      return listUploadedFiles(tables);
    case "query_uploaded_table":
      return queryUploadedTable(input, tables);
    case "join_uploaded_table":
      return joinUploadedTable(input, tables, data);
    default:
      return { error: `Unknown uploaded-table tool: ${name}` };
  }
}
```

- [ ] **Step 3: Extend the verify script with tool assertions**

Append to `scripts/verify-attachments.ts` (before the final `console.log` in `main()`, and add the import at the top):
```ts
// add near the top imports:
import { executeUploadedTableTool } from "../lib/attachment-tools";
import type { ChatDataset } from "../lib/ai-tools";
import type { UploadedTable } from "../lib/attachments";
```
```ts
// add inside main(), before the final console.log:
const table: UploadedTable = {
  fileId: "F1",
  filename: "ventas.csv",
  schema: [
    { name: "email", type: "text" },
    { name: "monto", type: "number" },
    { name: "estado", type: "text" },
  ],
  rowCount: 3,
  rows: [
    { email: "a@x.com", monto: "100", estado: "activo" },
    { email: "b@x.com", monto: "300", estado: "activo" },
    { email: "c@x.com", monto: "200", estado: "baja" },
  ],
};
const tables = [table];
const emptyData = {
  contacts: [{ id: "1", email: "a@x.com" }, { id: "2", email: "b@x.com" }],
  opportunities: [],
  pautas: [], appointments: [], messages: [], tasks: [], calls: [],
} as unknown as ChatDataset;

// list
const listed = executeUploadedTableTool("list_uploaded_files", {}, tables, emptyData) as { files: unknown[] };
assert.equal(listed.files.length, 1);

// query: grouped sum
const grouped = executeUploadedTableTool(
  "query_uploaded_table",
  { fileId: "F1", groupBy: "estado", metric: "sum", metricColumn: "monto" },
  tables, emptyData
) as { groups: Array<{ key: string; count: number; sum: number }> };
const activo = grouped.groups.find((g) => g.key === "activo");
assert.ok(activo && activo.count === 2 && activo.sum === 400);

// query: filter + total
const filtered = executeUploadedTableTool(
  "query_uploaded_table",
  { fileId: "F1", filter: { estado: "baja" } },
  tables, emptyData
) as { rowCount: number };
assert.equal(filtered.rowCount, 1);

// join: matched vs unmatched against contacts.email
const joined = executeUploadedTableTool(
  "join_uploaded_table",
  { fileId: "F1", tableColumn: "email", entity: "contacts", entityField: "email", mode: "both" },
  tables, emptyData
) as { matchedCount: number; unmatchedCount: number };
assert.equal(joined.matchedCount, 2); // a@, b@
assert.equal(joined.unmatchedCount, 1); // c@

// unknown fileId
const missing = executeUploadedTableTool("query_uploaded_table", { fileId: "nope" }, tables, emptyData) as { error?: string };
assert.ok(missing.error);
```
Update the final log line to `console.log("verify-attachments (Tasks 1-2): OK");`.

- [ ] **Step 4: Run the verify script**

Run:
```bash
npm run verify:attachments
```
Expected: `verify-attachments (Tasks 1-2): OK`

- [ ] **Step 5: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors. (`ToolName` now includes the 3 new names.)

- [ ] **Step 6: Commit**

```bash
git add lib/ai-tools.ts lib/attachment-tools.ts scripts/verify-attachments.ts
git commit -m "feat(attachments): uploaded-table tools (list/query/join) + schemas"
```

---

## Task 3: Server-side processing route

**Files:**
- Create: `app/api/attachments/process/route.ts`

**Interfaces:**
- Consumes: `ProcessedAttachment`, `buildTableSummary` (from `lib/attachments.ts`).
- Produces: `POST /api/attachments/process` — accepts `multipart/form-data` with one `file` field; returns `{ results: ProcessedAttachment[] }` or `{ error }`.

- [ ] **Step 1: Create the route**

Create `app/api/attachments/process/route.ts`:
```ts
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { extractText, getDocumentProxy } from "unpdf";
import { buildTableSummary, type ProcessedAttachment } from "@/lib/attachments";

export const runtime = "nodejs";

const MAX_PDF = 32 * 1024 * 1024;
const MAX_TABULAR = 25 * 1024 * 1024;

// Below this many non-whitespace chars we treat a PDF as scanned/imagey and fall
// back to sending it as a native document block so Claude can read it visually.
const MIN_PDF_TEXT = 40;

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

async function processPdf(filename: string, buf: Uint8Array): Promise<ProcessedAttachment> {
  const pdf = await getDocumentProxy(buf);
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const merged = Array.isArray(text) ? text.join("\n") : text;
  if (merged.replace(/\s/g, "").length >= MIN_PDF_TEXT) {
    return { kind: "pdf_text", filename, text: merged, pageCount: totalPages };
  }
  const base64 = Buffer.from(buf).toString("base64");
  return { kind: "pdf_visual", filename, mediaType: "application/pdf", dataBase64: base64 };
}

function processTabular(filename: string, buf: Uint8Array): ProcessedAttachment[] {
  const wb = XLSX.read(buf, { type: "array" });
  const out: ProcessedAttachment[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
    if (rows.length === 0) continue;
    const { schema, stats, sampleRows } = buildTableSummary(rows, { sampleSize: 8 });
    out.push({
      kind: "table",
      filename,
      sheetName: wb.SheetNames.length > 1 ? sheetName : undefined,
      schema,
      rowCount: rows.length,
      sampleRows,
      stats,
      rows,
    });
  }
  return out;
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Se esperaba multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Falta el archivo" }, { status: 400 });
  }

  const name = file.name || "archivo";
  const kind = ext(name);
  const buf = new Uint8Array(await file.arrayBuffer());

  try {
    if (kind === "pdf") {
      if (buf.byteLength > MAX_PDF) return NextResponse.json({ error: "PDF supera 32 MB" }, { status: 413 });
      return NextResponse.json({ results: [await processPdf(name, buf)] });
    }
    if (kind === "csv" || kind === "xlsx" || kind === "xls") {
      if (buf.byteLength > MAX_TABULAR) return NextResponse.json({ error: "Archivo supera 25 MB" }, { status: 413 });
      const results = processTabular(name, buf);
      if (results.length === 0) return NextResponse.json({ error: "El archivo no tiene filas legibles" }, { status: 422 });
      return NextResponse.json({ results });
    }
    return NextResponse.json({ error: `Tipo no soportado: .${kind}` }, { status: 415 });
  } catch (err) {
    console.error("[/api/attachments/process] error:", err);
    return NextResponse.json({ error: "No se pudo procesar el archivo" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors. If `unpdf`'s `extractText` return type differs, adjust the `text`/`totalPages` destructuring to match its actual signature (it returns `{ totalPages, text }`).

- [ ] **Step 3: Smoke-test the route against real files**

Start the dev server and post a real CSV and PDF. Run:
```bash
npm run dev
```
Then in a second terminal (replace paths with real local files):
```bash
curl -s -F "file=@/path/to/sample.csv" http://localhost:3000/api/attachments/process | head -c 600; echo
curl -s -F "file=@/path/to/sample.pdf" http://localhost:3000/api/attachments/process | head -c 300; echo
```
Expected: CSV returns `{"results":[{"kind":"table",...,"schema":[...],"rowCount":N,...}]}`; PDF returns `kind":"pdf_text"` (or `pdf_visual` for a scanned PDF).
Note: the route is behind middleware — if it 401s, hit it from the logged-in browser instead (Task 5 wires the real upload), or temporarily test via the app.

- [ ] **Step 4: Commit**

```bash
git add app/api/attachments/process/route.ts
git commit -m "feat(attachments): server route parsing PDF (unpdf) + CSV/Excel (xlsx)"
```

---

## Task 4: Agent-loop plumbing — content blocks, tables ref, send(attachments)

**Files:**
- Modify: `hooks/use-agent-loop.ts`

**Interfaces:**
- Consumes: `executeUploadedTableTool` (Task 2), `UploadedTable` (Task 1).
- Produces:
  - `AnyBlock` union gains `ImageBlock` and `DocumentBlock`.
  - `ReadyAttachment` type (exported) describing what the composer hands to `send`.
  - `send(text: string, attachments?: ReadyAttachment[]): void` — new optional 2nd arg.
  - `AgentLoopReturn.send` signature updated accordingly.

- [ ] **Step 1: Add block + attachment types**

In `hooks/use-agent-loop.ts`, after the `ToolResultBlock` interface (line 35), add:
```ts
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export interface DocumentBlock {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
}
```
Update the `AnyBlock` union (line 36) to:
```ts
export type AnyBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | DocumentBlock;
```
Add, after the `AnswerPayload` type (around line 62):
```ts
import type { UploadedTable } from "@/lib/attachments";

// What the composer hands to send(): content blocks to append to the user
// message, plus any tabular files to register for the query/join tools.
export interface ReadyAttachment {
  blocks: Array<ImageBlock | DocumentBlock | TextBlock>;
  tables?: UploadedTable[];
}
```
(Place the `import` with the other imports at the top of the file.)

- [ ] **Step 2: Import the uploaded-table executor**

At the top of `hooks/use-agent-loop.ts`, extend the `lib/ai-tools` import area and add:
```ts
import { executeUploadedTableTool } from "@/lib/attachment-tools";
```

- [ ] **Step 3: Add the tables ref**

Inside `useAgentLoop`, next to the other refs (near `messagesRef`, line 137), add:
```ts
const uploadedTablesRef = useRef<UploadedTable[]>([]);
```

- [ ] **Step 4: Route the 3 new tools to their executor**

In `runWithMessages`, in the `toRun.map` executor chain (around line 230-255), add these branches **before** the final `else { result = executeTool(...) }`:
```ts
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
```

- [ ] **Step 5: Accept attachments in `send`**

Replace the `send` callback (lines 389-408) with:
```ts
  const send = useCallback(
    (text: string, attachments?: ReadyAttachment[]) => {
      if (busy) return;
      // If a clarifying question is open, route typed text as its answer.
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
```

- [ ] **Step 6: Update the `reset` callback to clear tables**

In the `reset` callback (lines 414-423), add:
```ts
    uploadedTablesRef.current = [];
```

- [ ] **Step 7: Update `AgentLoopReturn.send` type**

In the `AgentLoopReturn` interface (line 110), change:
```ts
  send: (text: string, attachments?: ReadyAttachment[]) => void;
```

- [ ] **Step 8: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors (the composer still calls `send(text)` — the 2nd arg is optional).

- [ ] **Step 9: Commit**

```bash
git add hooks/use-agent-loop.ts
git commit -m "feat(attachments): agent-loop plumbing — image/document blocks, tables ref, send(attachments)"
```

---

## Task 5: Composer UI — attach, drag-drop, paste, chips, wiring

**Files:**
- Modify: `components/dashboard/conversations-chat.tsx`

**Interfaces:**
- Consumes: `ReadyAttachment`, `ImageBlock`, `DocumentBlock`, `TextBlock` (Task 4); `ProcessedAttachment`, `formatTableSummaryText`, `UploadedTable` (Task 1); `POST /api/attachments/process` (Task 3).
- Produces: user-facing attach flow; still calls `send(text, readyAttachments)`.

- [ ] **Step 1: Add a helper module-scope function for building a ReadyAttachment**

At the top of `components/dashboard/conversations-chat.tsx`, add imports:
```ts
import { Paperclip, X, FileSpreadsheet, FileText as FileTextIcon, Image as ImageIcon } from "lucide-react";
import { formatTableSummaryText, type ProcessedAttachment, type UploadedTable } from "@/lib/attachments";
import type { ReadyAttachment, ImageBlock, DocumentBlock, TextBlock } from "@/hooks/use-agent-loop";
```
Below the `PROMPTS`/constants block (before the component), add:
```ts
const MAX_IMAGE = 5 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
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
      blocks.push({ type: "text", text: `Documento PDF adjunto — ${r.filename} (${r.pageCount} págs):\n${r.text}` });
    } else if (r.kind === "pdf_visual") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: r.dataBase64 } });
    } else {
      const fileId = crypto.randomUUID();
      tables.push({ fileId, filename: r.filename, sheetName: r.sheetName, schema: r.schema, rowCount: r.rowCount, rows: r.rows });
      blocks.push({ type: "text", text: formatTableSummaryText({ fileId, filename: r.filename, sheetName: r.sheetName, rowCount: r.rowCount, schema: r.schema, stats: r.stats, sampleRows: r.sampleRows }) });
    }
  }
  return { blocks, tables };
}
```

- [ ] **Step 2: Add attachment state + processing logic in the component**

Inside `ConversationsChat`, after `const [input, setInput] = useState("")` (line 156), add:
```ts
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const processFile = useCallback(async (file: File) => {
    const id = crypto.randomUUID();
    const kind = fileExt(file.name);
    const icon: Attachment["icon"] = IMAGE_TYPES[kind] ? "image" : kind === "pdf" ? "pdf" : "table";
    setAttachments((prev) => [...prev, { id, filename: file.name, icon, status: "processing" }]);

    const fail = (msg: string) =>
      setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "error", error: msg } : a)));
    const done = (ready: ReadyAttachment) =>
      setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "ready", ready } : a)));

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

  const addFiles = useCallback((files: FileList | File[]) => {
    for (const f of Array.from(files)) void processFile(f);
  }, [processFile]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);
```

- [ ] **Step 3: Update `handleSend` to include ready attachments**

Replace `handleSend` (lines 316-321) with:
```ts
  const handleSend = useCallback(() => {
    const text = input.trim();
    const ready = attachments.filter((a) => a.status === "ready" && a.ready).map((a) => a.ready!) as ReadyAttachment[];
    const anyProcessing = attachments.some((a) => a.status === "processing");
    if (busy || anyProcessing) return;
    if (!text && ready.length === 0) return;
    setInput("");
    setAttachments([]);
    send(text, ready);
  }, [input, attachments, busy, send]);
```

- [ ] **Step 4: Clear attachments on reset**

In `handleReset` (lines 323-327), add `setAttachments([]);`.

- [ ] **Step 5: Render the attach button, chips, and drop zone**

In the input bar JSX (the `{/* Input bar */}` div, line 463-464), wrap it as a drop target and add the chip row + attach button. Replace the opening of that block:
```tsx
        {/* Input bar */}
        <div
          className="border-t border-border px-4 py-4 sm:px-5"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}
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
                    a.status === "error" ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border bg-muted/40",
                  )}
                >
                  {a.icon === "image" ? <ImageIcon className="h-3 w-3" /> : a.icon === "pdf" ? <FileTextIcon className="h-3 w-3" /> : <FileSpreadsheet className="h-3 w-3" />}
                  <span className="max-w-[140px] truncate">{a.filename}</span>
                  {a.status === "processing" && <Loader2 className="h-3 w-3 animate-spin" />}
                  {a.status === "error" && <span title={a.error}>· error</span>}
                  <button type="button" onClick={() => removeAttachment(a.id)} className="text-muted-foreground hover:text-foreground">
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
            onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ""; }}
          />
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => { const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/")); if (imgs.length) { e.preventDefault(); addFiles(imgs); } }}
            placeholder="¿Qué quieres saber?"
            rows={2}
            className="min-h-[52px] w-full resize-none text-sm"
            disabled={busy}
          />
```
Then, in the button row (the `mt-2.5 flex items-center justify-between` div), add an attach button on the left, next to "Reiniciar". Immediately after the `Reiniciar` `</Button>`, wrap both in a flex container OR add:
```tsx
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
```
(Place it so the left side holds both "Reiniciar" and "Adjuntar"; e.g. wrap them in `<div className="flex items-center gap-1">…</div>`.)

- [ ] **Step 6: Enable the send button when attachments are ready**

Update the send `Button`'s `disabled` (line 504) to:
```tsx
                disabled={busy || attachments.some((a) => a.status === "processing") || (!input.trim() && !attachments.some((a) => a.status === "ready"))}
```

- [ ] **Step 7: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 8: Drive the app**

Run:
```bash
npm run dev
```
Log in, open the **Asistente IA** tab, and verify by attaching real files:
- An image (PNG/JPG) → chip with thumbnail icon; ask "¿qué ves en esta imagen?" → model describes it.
- A text PDF → ask "resume este PDF" → summary reflects contents.
- A CSV and a multi-sheet Excel → chip appears; ask "¿cuántas filas tiene el archivo y agrúpalo por <columna>" → model calls `query_uploaded_table` (visible in the tool chips) and answers.
- Cross-reference: attach a CSV/Excel with an `email` column → ask "de estos emails, ¿cuáles ya son contactos?" → model calls `join_uploaded_table` and reports matched/unmatched counts.
- Drag-drop a file onto the input; paste a screenshot into the textarea — both add chips.
- Remove a chip with "x"; send with only an attachment and no text.

- [ ] **Step 9: Commit**

```bash
git add components/dashboard/conversations-chat.tsx
git commit -m "feat(attachments): composer UI — attach button, drag-drop, paste, preview chips"
```

---

## Task 6: System-prompt section for attachments

**Files:**
- Modify: `lib/ai-context.ts`

**Interfaces:**
- Consumes: nothing new. Produces: an "# Archivos adjuntos" section in `ASSISTANT_SYSTEM_PROMPT`.

- [ ] **Step 1: Add the prompt section**

In `lib/ai-context.ts`, inside the `ASSISTANT_SYSTEM_PROMPT` template literal, add this section immediately **before** the `# Exportar a CSV` section (line 311):
```
# Archivos adjuntos

El usuario puede adjuntar imágenes, PDF, CSV o Excel al chat.
- **Imágenes y PDF**: su contenido ya está en el mensaje (la imagen se ve; el PDF viene como texto extraído o como documento). Analízalos directamente. No existe herramienta para "abrirlos".
- **CSV / Excel (tabulares)**: en el mensaje solo recibes un RESUMEN (esquema de columnas, estadísticas y una muestra de pocas filas). El resumen NO es el total: NUNCA concluyas conteos, sumas o totales a partir de la muestra.
  - Para responder sobre TODO el archivo usa \`query_uploaded_table\` (filtra, agrupa, cuenta, suma, promedia sobre todas las filas) con el \`fileId\` que aparece en el resumen o que obtienes de \`list_uploaded_files\`.
  - Para CRUZAR el archivo con el CRM (ej. "de estos emails/teléfonos del archivo, cuáles ya son contactos / cuáles no") usa \`join_uploaded_table\` — lo hace en UNA sola llamada. No lo hagas a mano fila por fila con \`search_contacts\`.
  - Si el usuario menciona varios archivos o no sabes el \`fileId\`, llama \`list_uploaded_files\` primero.
- Los archivos viven solo en esta sesión. Si el usuario reinicia el chat, desaparecen.
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Drive the app to confirm the model uses the tools**

Run `npm run dev`, attach a CSV, and confirm the model reaches for `query_uploaded_table`/`join_uploaded_table` (tool chips) rather than guessing from the sample. Ask a total ("¿cuántas filas en total?") and confirm it queries rather than counting the sample.

- [ ] **Step 4: Commit**

```bash
git add lib/ai-context.ts
git commit -m "feat(attachments): system-prompt guidance for attached files & tools"
```

---

## Final Verification

- [ ] **Step 1: Full typecheck + pure-module verifications**

Run:
```bash
npx tsc --noEmit && npm run verify:attachments && npm run verify:clients && npm run verify:auth && npm run verify:limiter
```
Expected: tsc clean; `verify-attachments (Tasks 1-2): OK`; the other three still pass (no regressions).

- [ ] **Step 2: End-to-end app pass**

Run `npm run dev` and confirm, in the Asistente IA tab: image analysis, text-PDF summary, scanned-PDF visual fallback (attach an image-only PDF), CSV/Excel `query_uploaded_table` totals, and `join_uploaded_table` cross-reference against contacts — plus drag-drop, paste, chip removal, and send-with-attachment-only. Confirm the cost counter increases sensibly and no raw contact IDs are printed.

- [ ] **Step 3: Final commit if anything is uncommitted**

```bash
git status
```

---

## Self-Review Notes (author)

- **Spec coverage:** server-side processing route ✓ (T3); images client-side ✓ (T5 Step 2); PDF text+visual fallback ✓ (T3); tabular summary vs full rows ✓ (T1/T5); 3 tools ✓ (T2); composer attach/drag/paste/chips ✓ (T5); types/plumbing ✓ (T4); prompt section ✓ (T6); libraries `xlsx`+`unpdf` ✓ (T1); 50k-row warning — **note:** the plan enforces size caps (bytes) and the summary is always bounded; an explicit row-count warning banner is a nice-to-have not wired in T5 — acceptable since the byte cap (25 MB) bounds worst case and the tools operate on full rows regardless. If desired, add a chip note when `rowCount > 50000`.
- **Type consistency:** `ReadyAttachment`, `ImageBlock`, `DocumentBlock` defined in `hooks/use-agent-loop.ts` (T4) and consumed in `conversations-chat.tsx` (T5); `ProcessedAttachment`/`UploadedTable`/`buildTableSummary`/`formatTableSummaryText` defined in `lib/attachments.ts` (T1) and consumed in T2/T3/T5. `executeUploadedTableTool` signature `(name, input, tables, data)` consistent across T2 (def) and T4 (call). Tool names identical in `TOOL_DEFINITIONS` (T2) and the hook switch (T4).
