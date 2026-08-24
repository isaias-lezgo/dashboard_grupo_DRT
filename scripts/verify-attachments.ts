import assert from "node:assert/strict";
import {
  inferColumnType,
  buildTableSummary,
  formatTableSummaryText,
  type UploadedTable,
} from "../lib/attachments";
import { executeUploadedTableTool } from "../lib/attachment-tools";
import type { ChatDataset } from "../lib/ai-tools";

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
  // The sample must be bounded to sampleSize (2), not the full 3 rows. Stats may
  // legitimately mention any value; assert only on the "Muestra" section.
  const samplePart = text.slice(text.indexOf("Muestra"));
  assert.equal((samplePart.match(/"email"/g) ?? []).length, 2);

  // ─── uploaded-table tools ────────────────────────────────────────────────────
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
    contacts: [
      { id: "1", email: "a@x.com" },
      { id: "2", email: "b@x.com" },
    ],
    opportunities: [],
    pautas: [],
    appointments: [],
    messages: [],
    tasks: [],
    calls: [],
  } as unknown as ChatDataset;

  // list
  const listed = executeUploadedTableTool("list_uploaded_files", {}, tables, emptyData) as { files: unknown[] };
  assert.equal(listed.files.length, 1);

  // query: grouped sum
  const grouped = executeUploadedTableTool(
    "query_uploaded_table",
    { fileId: "F1", groupBy: "estado", metric: "sum", metricColumn: "monto" },
    tables,
    emptyData
  ) as { groups: Array<{ key: string; count: number; sum: number }> };
  const activo = grouped.groups.find((g) => g.key === "activo");
  assert.ok(activo && activo.count === 2 && activo.sum === 400);

  // query: filter + total
  const filtered = executeUploadedTableTool(
    "query_uploaded_table",
    { fileId: "F1", filter: { estado: "baja" } },
    tables,
    emptyData
  ) as { rowCount: number };
  assert.equal(filtered.rowCount, 1);

  // join: matched vs unmatched against contacts.email
  const joined = executeUploadedTableTool(
    "join_uploaded_table",
    { fileId: "F1", tableColumn: "email", entity: "contacts", entityField: "email", mode: "both" },
    tables,
    emptyData
  ) as { matchedCount: number; unmatchedCount: number };
  assert.equal(joined.matchedCount, 2); // a@, b@
  assert.equal(joined.unmatchedCount, 1); // c@

  // unknown fileId
  const missing = executeUploadedTableTool("query_uploaded_table", { fileId: "nope" }, tables, emptyData) as {
    error?: string;
  };
  assert.ok(missing.error);

  console.log("verify-attachments (Tasks 1-2): OK");
}

main();
