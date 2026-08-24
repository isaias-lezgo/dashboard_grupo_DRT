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
    let sum = 0;
    let seen = 0;
    for (const r of subset) {
      const n = toNum(cell(r, metricColumn));
      if (n !== null) {
        sum += n;
        seen++;
      }
    }
    return metric === "sum" ? { count: subset.length, sum } : { count: subset.length, avg: seen ? sum / seen : 0 };
  };

  if (groupBy) {
    const buckets = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const key = String(cell(r, groupBy) ?? "(sin valor)");
      const b = buckets.get(key);
      if (b) b.push(r);
      else buckets.set(key, [r]);
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

  const crmRecords: Record<string, unknown>[] =
    entity === "opportunities"
      ? (data.opportunities as unknown as Record<string, unknown>[])
      : (data.contacts as unknown as Record<string, unknown>[]);
  const crmSet = new Set<string>();
  for (const rec of crmRecords) {
    const v = rec[entityField];
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
