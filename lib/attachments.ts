// Shared attachment types + pure helpers. The pure parts (type inference,
// summary building, summary formatting) are asserted in scripts/verify-attachments.ts.
// Client-only helpers (file reading) live in the composer; this module stays
// framework-free so it can run in the verify script and in the server route.

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
    const trimmed = v.trim();
    if (trimmed !== "" && NUMERIC_RE.test(trimmed)) {
      const n = Number(trimmed.replace(/,/g, ""));
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
    let min = nums[0];
    let max = nums[0];
    let sum = 0;
    for (const n of nums) {
      if (n < min) min = n;
      if (n > max) max = n;
      sum += n;
    }
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
      if (!seen.has(k)) {
        seen.add(k);
        colNames.push(k);
      }
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

// Stable prefixes for the attachment-derived text blocks. The chat transcript
// uses these to recognize an attachment text block and render it as a compact
// chip instead of dumping the whole summary/extracted text as a message bubble.
// Keep them in sync with the text the formatters below produce.
export const TABLE_SUMMARY_PREFIX = "Archivo tabular adjunto";
export const PDF_TEXT_PREFIX = "Documento PDF adjunto";

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
    `${TABLE_SUMMARY_PREFIX} — fileId: "${t.fileId}" · ${t.filename}` +
    (t.sheetName ? ` · hoja "${t.sheetName}"` : "") +
    ` · ${t.rowCount} filas.`;
  const cols = t.schema.map((c) => `${c.name} (${c.type})`).join(", ");
  const statLines = t.stats.map((s) => {
    if (s.type === "number")
      return `- ${s.name}: min ${s.min}, max ${s.max}, suma ${s.sum}, prom ${s.avg.toFixed(2)} (${s.nonEmpty} con valor)`;
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
