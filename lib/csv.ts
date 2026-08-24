// Shared CSV serialization. The single source of truth for how a cell is
// escaped and how rows are joined, used by the AI assistant's export_csv tool
// (lib/ai-tools.ts) and the chart drill drawer's "Exportar" button
// (lib/drill-export.ts). Keep escaping identical across both exports.

export function csvCell(val: unknown): string {
  if (val === null || val === undefined) return "";
  let str: string;
  if (Array.isArray(val)) str = (val as unknown[]).join("|");
  else if (typeof val === "object") str = JSON.stringify(val);
  else str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines: string[] = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }
  return lines.join("\r\n");
}
