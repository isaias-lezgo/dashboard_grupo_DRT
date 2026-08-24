import type { Content, TableCell } from "pdfmake/interfaces";
import type { PdfBlock, CalloutStyle } from "./types";
import { C, sanitizeBrand, hr } from "./branding";
import { buildChart } from "./charts";

const CALLOUT: Record<CalloutStyle, { bg: string; text: string; accent: string }> = {
  info: { bg: C.naranjaClar, text: C.amarilloTxt, accent: C.naranja },
  warn: { bg: C.amarilloBg, text: C.amarilloTxt, accent: C.naranja },
  ok: { bg: C.verdeClaro, text: C.verde, accent: C.verde },
  error: { bg: C.rojoClaro, text: C.rojoText, accent: C.rojoText },
};

// Minimal **bold** inline parser → pdfmake text runs.
function inline(text: string): Content {
  const parts = sanitizeBrand(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return {
    text: parts.map((p) =>
      p.startsWith("**") && p.endsWith("**")
        ? { text: p.slice(2, -2), bold: true }
        : { text: p },
    ),
    style: "body",
  };
}

const KPI_GAP = 8;
const KPI_MAX_PER_ROW = 4;

// Long values ("WhatsApp (100%)") shrink instead of wrapping across the card.
function kpiFontSize(value: string): number {
  if (value.length > 14) return 12;
  if (value.length > 9) return 14;
  return 18;
}

// One row of up to `cols` cards as a single flat table: star widths guarantee
// the row fits USABLE_WIDTH (nested tables inside `columns` could overflow it).
function kpiRow(items: { label: string; value: string }[], cols: number): Content {
  const noBorder: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  const widths: ("*" | number)[] = [];
  const valueCells: TableCell[] = [];
  const labelCells: TableCell[] = [];
  for (let i = 0; i < cols; i++) {
    if (i > 0) {
      widths.push(KPI_GAP);
      valueCells.push({ text: "", border: noBorder });
      labelCells.push({ text: "", border: noBorder });
    }
    widths.push("*");
    const it = items[i];
    if (!it) {
      valueCells.push({ text: "", border: noBorder });
      labelCells.push({ text: "", border: noBorder });
      continue;
    }
    const value = sanitizeBrand(String(it.value ?? ""));
    valueCells.push({
      text: value,
      style: "kpiValue",
      fontSize: kpiFontSize(value),
      alignment: "center",
      fillColor: C.grisFondo,
      margin: [4, 8, 4, 0],
      // orange top accent on the card only (gap cells stay borderless)
      border: [false, true, false, false],
    });
    labelCells.push({
      text: sanitizeBrand(String(it.label ?? "")),
      style: "kpiLabel",
      alignment: "center",
      fillColor: C.grisFondo,
      margin: [4, 2, 4, 8],
      border: noBorder,
    });
  }
  return {
    table: { widths, body: [valueCells, labelCells] },
    layout: {
      hLineWidth: (i: number) => (i === 0 ? 2 : 0),
      hLineColor: () => C.naranja,
      vLineWidth: () => 0,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 4, 0, 6],
  };
}

function kpis(items: { label: string; value: string }[]): Content {
  if (!items.length) return { text: "" };
  // Balance rows: 6 cards → 3+3 (not 4+2), 7 → 4+3, ≤4 → one row.
  const rowCount = Math.ceil(items.length / KPI_MAX_PER_ROW);
  const perRow = Math.ceil(items.length / rowCount);
  const rows: Content[] = [];
  for (let i = 0; i < items.length; i += perRow) {
    rows.push(kpiRow(items.slice(i, i + perRow), perRow));
  }
  return { stack: rows, margin: [0, 0, 0, 2] };
}

function table(headers: string[], rows: string[][]): Content {
  const body: TableCell[][] = [
    headers.map((h) => ({ text: sanitizeBrand(h), style: "th", margin: [4, 4, 4, 4] as [number, number, number, number] })),
    ...rows.map((r) =>
      r.map((cell) => ({ text: sanitizeBrand(String(cell ?? "")), style: "td", margin: [4, 3, 4, 3] as [number, number, number, number] })),
    ),
  ];
  // On a 712pt-wide landscape page, all-"*" columns give a numeric column the
  // same 140pt as the label column — the numbers float and the labels wrap. From
  // 3 columns on, the first (almost always the label) absorbs the slack and the
  // rest size to their content.
  const widths: ("*" | "auto")[] =
    headers.length >= 3
      ? headers.map((_, i) => (i === 0 ? "*" : "auto"))
      : headers.map(() => "*");
  return {
    table: { headerRows: 1, widths, body },
    layout: {
      fillColor: (rowIndex: number) =>
        rowIndex === 0 ? C.azul : rowIndex % 2 === 0 ? C.grisFondo : null,
      hLineWidth: () => 0.5,
      vLineWidth: () => 0,
      hLineColor: () => C.grisBorde,
    },
    margin: [0, 4, 0, 8],
  };
}

function callout(style: CalloutStyle, text: string): Content {
  const c = CALLOUT[style] ?? CALLOUT.info;
  const clean = sanitizeBrand(text);
  // A short "Lead-in:" prefix (e.g. "Análisis IA:") is pulled out as a bold,
  // accent-colored label so the body reads as a captioned note, not a wall.
  const m = clean.match(/^([^:.\n]{2,28}):\s+([\s\S]+)$/);
  const runs: Content[] = m
    ? [
        { text: `${m[1]}  `, bold: true, color: c.accent },
        { text: m[2], color: c.text },
      ]
    : [{ text: clean, color: c.text }];
  const noBorder: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  return {
    table: {
      widths: [3.5, "*"],
      body: [[
        // Accent rail down the left edge.
        { text: "", fillColor: c.accent, border: noBorder },
        {
          text: runs,
          fontSize: 10,
          lineHeight: 1.45,
          fillColor: c.bg,
          margin: [14, 12, 16, 12],
          border: noBorder,
        },
      ]],
    },
    layout: { defaultBorder: false, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
    margin: [0, 6, 0, 10],
  };
}

/** Convert one spec block into pdfmake content. Returns null for unknown blocks. */
export function buildBlock(block: PdfBlock): Content | null {
  switch (block.t) {
    case "heading":
      return { stack: [{ text: sanitizeBrand(block.text), style: "heading" }, hr(C.naranja, 1.2)] };
    case "subheading":
      return { text: sanitizeBrand(block.text), style: "subheading" };
    case "text":
      return inline(block.text);
    case "bullets":
      return { ul: block.items.map((i) => sanitizeBrand(i)), style: "body", margin: [0, 0, 0, 6] };
    case "kpis":
      return kpis(block.items);
    case "table":
      return table(block.headers, block.rows);
    case "callout":
      return callout(block.style, block.text);
    case "chart":
      return buildChart(block);
    default:
      return null;
  }
}
