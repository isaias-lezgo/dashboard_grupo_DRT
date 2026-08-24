import type { Content, CanvasElement } from "pdfmake/interfaces";
import type { PdfChartBlock, SimpleSeriesPoint, MultiSeries } from "./types";
import { C, SERIES_COLORS, USABLE_WIDTH, sanitizeBrand } from "./branding";

// Landscape widened the plot to ~670pt, so the box grows vertically too — at the
// old 180 a full-width chart read as a squat 3.7:1 strip.
const PLOT_H = 220;
const PAD_LEFT = 34;
const PAD_TOP = 8;
const PLOT_W = USABLE_WIDTH - PAD_LEFT - 8;
// Category-label gutter on horizontal bars. The extra landscape width goes to
// the labels first (loss reasons, pauta names) — the track is long either way.
const LABEL_W = 150;

// Softer-than-border tone for gridlines so they read as a quiet guide, and a
// slightly stronger tone reserved for the single baseline that grounds the plot.
const GRID = "#EEF1F4";
const BASELINE = "#D8DCE2";

function isMulti(block: PdfChartBlock): boolean {
  return Array.isArray(block.categories) && block.categories.length > 0;
}

// Round up to the next half power of ten (109 → 150, 318 → 350) so the
// largest bar fills most of the plot instead of stranding at ~60%.
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const half = Math.pow(10, Math.floor(Math.log10(v))) / 2;
  return Math.ceil(v / half) * half;
}

/** Clamp a corner radius so short/thin bars never round into a blob. */
function barRadius(w: number, h: number, max = 3): number {
  return Math.max(0, Math.min(max, w / 2, h / 2));
}

/** Light horizontal gridlines at 25/50/75/100% of the plot height. */
function gridLines(): CanvasElement[] {
  return [0.25, 0.5, 0.75, 1].map((f) => ({
    type: "line" as const,
    x1: PAD_LEFT,
    y1: PAD_TOP + PLOT_H * (1 - f),
    x2: PAD_LEFT + PLOT_W,
    y2: PAD_TOP + PLOT_H * (1 - f),
    lineWidth: 0.5,
    lineColor: GRID,
  }));
}

/** Single grounding baseline at the foot of the plot (no boxed-in y-axis). */
function baseline(): CanvasElement {
  return {
    type: "line",
    x1: PAD_LEFT,
    y1: PAD_TOP + PLOT_H,
    x2: PAD_LEFT + PLOT_W,
    y2: PAD_TOP + PLOT_H,
    lineWidth: 1,
    lineColor: BASELINE,
  };
}

function legend(names: string[]): Content {
  return {
    columns: names.map((name, i) => ({
      width: "auto",
      columns: [
        { canvas: [{ type: "rect", x: 0, y: 2, w: 9, h: 9, r: 2.5, color: SERIES_COLORS[i % SERIES_COLORS.length] }], width: 13 },
        { text: sanitizeBrand(name), fontSize: 8, color: C.grisMed, margin: [0, 1, 12, 0] },
      ],
    })),
    margin: [PAD_LEFT, 6, 0, 0],
  };
}

// ─── simple vertical bar ───────────────────────────────────────────────────────
function barVertical(block: PdfChartBlock): Content {
  const pts = block.series as SimpleSeriesPoint[];
  const max = niceMax(Math.max(0, ...pts.map((p) => p.value)));
  const slot = PLOT_W / Math.max(1, pts.length);
  const bw = Math.min(48, slot * 0.6);
  const canvas: CanvasElement[] = [...gridLines(), baseline()];
  pts.forEach((p, i) => {
    const h = max > 0 ? (p.value / max) * PLOT_H : 0;
    const x = PAD_LEFT + i * slot + (slot - bw) / 2;
    const y = PAD_TOP + PLOT_H - h;
    if (h <= 0) return;
    // Faint full-height track behind each bar grounds short bars visually.
    canvas.push({ type: "rect", x, y: PAD_TOP, w: bw, h: PLOT_H, r: 3, color: C.grisFondo });
    canvas.push({ type: "rect", x, y, w: bw, h, r: barRadius(bw, h), color: C.naranja });
  });
  const vals: Content = {
    columns: pts.map((p) => ({
      width: slot,
      text: String(p.value),
      fontSize: 8.5,
      bold: true,
      color: C.negroText,
      alignment: "center",
    })),
    margin: [PAD_LEFT, 6, 0, 0],
  };
  const cats: Content = {
    columns: pts.map((p) => ({
      width: slot,
      text: sanitizeBrand(p.label),
      fontSize: 7.5,
      color: C.grisSuave,
      alignment: "center",
    })),
    margin: [PAD_LEFT, 2, 0, 0],
  };
  return {
    stack: [
      ...(block.title ? [{ text: sanitizeBrand(block.title), style: "chartTitle" } as Content] : []),
      { canvas },
      vals,
      cats,
    ],
    unbreakable: true,
    margin: [0, 4, 0, 10],
  };
}

// ─── simple horizontal bar ─────────────────────────────────────────────────────
function barHorizontal(block: PdfChartBlock): Content {
  const pts = block.series as SimpleSeriesPoint[];
  const max = niceMax(Math.max(0, ...pts.map((p) => p.value)));
  const labelW = LABEL_W;
  const valueW = 34;
  const gap = 8;
  const barH = 13;
  const trackW = USABLE_WIDTH - labelW - valueW - gap * 2;
  // Each row holds its own bar canvas inline, so label / bar / value always
  // share a baseline and the chart flows normally (no canvas overlay tricks).
  const rows: Content[] = pts.map((p) => {
    const w = Math.max(barH, max > 0 ? (p.value / max) * trackW : 0);
    return {
      columns: [
        { width: labelW, text: sanitizeBrand(p.label), fontSize: 8, color: C.grisMed, lineHeight: 1.1, margin: [0, 2, 0, 0] },
        {
          width: "*",
          canvas: [
            { type: "rect", x: 0, y: 0, w: trackW, h: barH, r: barH / 2, color: C.grisFondo },
            { type: "rect", x: 0, y: 0, w: w, h: barH, r: barH / 2, color: C.naranja },
          ] as CanvasElement[],
        },
        { width: valueW, text: String(p.value), fontSize: 8.5, bold: true, color: C.negroText, alignment: "right", margin: [0, 2, 0, 0] },
      ],
      columnGap: gap,
      margin: [0, 3, 0, 3],
    } as Content;
  });
  return {
    stack: [
      ...(block.title ? [{ text: sanitizeBrand(block.title), style: "chartTitle" } as Content] : []),
      ...rows,
    ],
    // Keep short charts on one page; very long ones may still flow.
    unbreakable: pts.length <= 20,
    margin: [0, 4, 0, 12],
  };
}

// ─── stacked horizontal bar (multi-series) ─────────────────────────────────────
// Same row layout as barHorizontal — long category labels (razones de pérdida,
// nombres de pauta) get a real column instead of being crushed under a vertical
// axis — with each track split into its series segments.
function barHorizontalMulti(block: PdfChartBlock): Content {
  const cats = block.categories!;
  const series = block.series as MultiSeries[];
  const totals = cats.map((_, ci) => series.reduce((s, ser) => s + (ser.values[ci] ?? 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const labelW = LABEL_W;
  const valueW = 34;
  const gap = 8;
  const barH = 13;
  const trackW = USABLE_WIDTH - labelW - valueW - gap * 2;

  const rows: Content[] = cats.map((cat, ci) => {
    const segments: CanvasElement[] = [
      { type: "rect", x: 0, y: 0, w: trackW, h: barH, r: barH / 2, color: C.grisFondo },
    ];
    let x = 0;
    series.forEach((ser, si) => {
      const v = ser.values[ci] ?? 0;
      if (v <= 0) return;
      const w = (v / max) * trackW;
      segments.push({
        type: "rect",
        x,
        y: 0,
        // Round only the outer ends so the stack reads as one continuous bar.
        w: Math.max(0.5, w),
        h: barH,
        r: barRadius(w, barH, barH / 2),
        color: SERIES_COLORS[si % SERIES_COLORS.length],
      });
      x += w;
    });
    return {
      columns: [
        { width: labelW, text: sanitizeBrand(cat), fontSize: 8, color: C.grisMed, lineHeight: 1.1, margin: [0, 2, 0, 0] },
        { width: "*", canvas: segments },
        { width: valueW, text: String(totals[ci]), fontSize: 8.5, bold: true, color: C.negroText, alignment: "right", margin: [0, 2, 0, 0] },
      ],
      columnGap: gap,
      margin: [0, 3, 0, 3],
    } as Content;
  });

  return {
    stack: [
      ...(block.title ? [{ text: sanitizeBrand(block.title), style: "chartTitle" } as Content] : []),
      ...rows,
      { ...(legend(series.map((s) => s.name)) as object), margin: [0, 6, 0, 0] } as Content,
    ],
    unbreakable: cats.length <= 16,
    margin: [0, 4, 0, 12],
  };
}

// ─── stacked / grouped bar (multi-series) ──────────────────────────────────────
function barMulti(block: PdfChartBlock): Content {
  const cats = block.categories!;
  const series = block.series as MultiSeries[];
  const stacked = block.stacked === true;
  const totals = cats.map((_, ci) =>
    stacked
      ? series.reduce((s, ser) => s + (ser.values[ci] ?? 0), 0)
      : Math.max(0, ...series.map((ser) => ser.values[ci] ?? 0)),
  );
  const max = niceMax(Math.max(1, ...totals));
  const slot = PLOT_W / Math.max(1, cats.length);
  const groupW = Math.min(60, slot * 0.7);
  const canvas: CanvasElement[] = [...gridLines(), baseline()];
  cats.forEach((_, ci) => {
    const baseX = PAD_LEFT + ci * slot + (slot - groupW) / 2;
    if (stacked) {
      // Hairline white gaps between segments read cleaner than abutting blocks.
      let yCursor = PAD_TOP + PLOT_H;
      series.forEach((ser, si) => {
        const v = ser.values[ci] ?? 0;
        const h = max > 0 ? (v / max) * PLOT_H : 0;
        if (h <= 0) return;
        yCursor -= h;
        const topMost = si === series.length - 1;
        canvas.push({
          type: "rect",
          x: baseX,
          y: yCursor,
          w: groupW,
          h: topMost ? h : Math.max(0, h - 1),
          r: topMost ? barRadius(groupW, h, 2.5) : 0,
          color: SERIES_COLORS[si % SERIES_COLORS.length],
        });
      });
    } else {
      const innerGap = 2;
      const bw = (groupW - innerGap * (series.length - 1)) / Math.max(1, series.length);
      series.forEach((ser, si) => {
        const v = ser.values[ci] ?? 0;
        const h = max > 0 ? (v / max) * PLOT_H : 0;
        if (h <= 0) return;
        const x = baseX + si * (bw + innerGap);
        canvas.push({ type: "rect", x, y: PAD_TOP + PLOT_H - h, w: bw, h, r: barRadius(bw, h, 2.5), color: SERIES_COLORS[si % SERIES_COLORS.length] });
      });
    }
  });
  const catRow: Content = {
    columns: cats.map((c) => ({ width: slot, text: sanitizeBrand(c), fontSize: 7, color: C.grisSuave, alignment: "center" })),
    margin: [PAD_LEFT, 2, 0, 0],
  };
  return {
    stack: [
      ...(block.title ? [{ text: sanitizeBrand(block.title), style: "chartTitle" } as Content] : []),
      { canvas },
      catRow,
      legend(series.map((s) => s.name)),
    ],
    unbreakable: true,
    margin: [0, 4, 0, 10],
  };
}

// ─── pie ───────────────────────────────────────────────────────────────────────
function pie(block: PdfChartBlock): Content {
  const pts = block.series as SimpleSeriesPoint[];
  const total = pts.reduce((s, p) => s + Math.max(0, p.value), 0);
  // Donut column is fixed-width (see colW) and cx sits at its center, so the
  // centered total label lands exactly in the hole.
  const cx = 120;
  const cy = PAD_TOP + 108;
  const r = 100;
  const rInner = r * 0.62; // donut hole — roomy enough to hold the total
  const canvas: CanvasElement[] = [];
  let a0 = -Math.PI / 2;
  pts.forEach((p, i) => {
    const frac = total > 0 ? Math.max(0, p.value) / total : 0;
    if (frac <= 0) return;
    const a1 = a0 + frac * Math.PI * 2;
    // Smooth the arc with enough segments; white stroke on the fan edges
    // becomes the slim gap between slices and an outer rim.
    const steps = Math.max(3, Math.ceil(frac * 64));
    const points: { x: number; y: number }[] = [{ x: cx, y: cy }];
    for (let s = 0; s <= steps; s++) {
      const a = a0 + (a1 - a0) * (s / steps);
      points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    canvas.push({
      type: "polyline",
      closePath: true,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      lineColor: C.blanco,
      lineWidth: 2.5,
      points,
    });
    a0 = a1;
  });
  // Punch the donut hole, then a faint inner ring to frame the total.
  canvas.push({ type: "ellipse", x: cx, y: cy, r1: rInner, r2: rInner, color: C.blanco });
  canvas.push({ type: "ellipse", x: cx, y: cy, r1: rInner, r2: rInner, lineColor: GRID, lineWidth: 1 });
  // Total, centered in the hole via relativePosition (pulled out of the flow so
  // it overlays the donut canvas without consuming layout height).
  const colW = 240;
  const cursorAfterCanvas = cy + r; // pdfmake canvas height ≈ lowest drawn point
  // Centered across the fixed-width column via `alignment`; pulled out of the
  // flow with relativePosition so it overlays the donut hole.
  const centerLabel: Content[] = [
    {
      text: total.toLocaleString("es-MX"),
      fontSize: 22,
      bold: true,
      color: C.negroText,
      alignment: "center",
      relativePosition: { x: 0, y: cy - cursorAfterCanvas - 14 },
    },
    {
      text: "Total",
      fontSize: 8.5,
      color: C.grisSuave,
      characterSpacing: 1,
      alignment: "center",
      relativePosition: { x: 0, y: cy - cursorAfterCanvas + 12 },
    },
  ];
  const rows: Content[] = pts.map((p, i) => {
    const pct = total > 0 ? Math.round((p.value / total) * 100) : 0;
    return {
      columns: [
        { canvas: [{ type: "rect", x: 0, y: 2, w: 9, h: 9, r: 2.5, color: SERIES_COLORS[i % SERIES_COLORS.length] }], width: 14 },
        { text: sanitizeBrand(p.label), fontSize: 9, color: C.grisMed, width: "*", margin: [0, 1, 0, 0] },
        { text: p.value.toLocaleString("es-MX"), fontSize: 9, color: C.grisSuave, width: 40, alignment: "right", margin: [0, 1, 0, 0] },
        { text: `${pct}%`, fontSize: 9, bold: true, color: C.negroText, width: 34, alignment: "right", margin: [0, 1, 0, 0] },
      ],
      margin: [0, i === 0 ? 0 : 9, 0, 0],
    } as Content;
  });
  // Vertically center the legend block against the donut middle.
  const legendTop = Math.max(8, Math.round(cy - pts.length * 9));
  return {
    stack: [
      ...(block.title ? [{ text: sanitizeBrand(block.title), style: "chartTitle" } as Content] : []),
      {
        columns: [
          { width: colW, stack: [{ canvas }, ...centerLabel] },
          {
            // Fixed, not "*": on a landscape page a star column would stretch
            // the legend to ~470pt and strand each percentage far from its label.
            width: 300,
            stack: rows,
            margin: [16, legendTop, 0, 0],
          },
          { width: "*", text: "" },
        ],
      },
    ],
    unbreakable: true,
    margin: [0, 4, 0, 10],
  };
}

// ─── line (mono or multi-series) ───────────────────────────────────────────────
function line(block: PdfChartBlock): Content {
  const multi = isMulti(block);
  const cats = multi ? block.categories! : (block.series as SimpleSeriesPoint[]).map((p) => p.label);
  const seriesList: { name: string; values: number[] }[] = multi
    ? (block.series as MultiSeries[]).map((s) => ({ name: s.name, values: s.values }))
    : [{ name: block.valueLabel ?? "Valor", values: (block.series as SimpleSeriesPoint[]).map((p) => p.value) }];
  const max = niceMax(Math.max(1, ...seriesList.flatMap((s) => s.values)));
  // Points sit at slot centers so they line up with the centered cat labels.
  const xAt = (i: number) => PAD_LEFT + ((i + 0.5) / Math.max(1, cats.length)) * PLOT_W;
  const yAt = (v: number) => PAD_TOP + PLOT_H - (max > 0 ? (v / max) * PLOT_H : 0);
  const canvas: CanvasElement[] = [...gridLines(), baseline()];
  // Single-series gets a soft tinted area under the line for depth; multi-series
  // stays line-only so overlapping fills don't turn muddy.
  if (!multi && seriesList[0]) {
    const pts = seriesList[0].values.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
    const area = [
      { x: pts[0].x, y: PAD_TOP + PLOT_H },
      ...pts,
      { x: pts[pts.length - 1].x, y: PAD_TOP + PLOT_H },
    ];
    canvas.push({ type: "polyline", closePath: true, color: C.naranjaClar, points: area });
  }
  seriesList.forEach((s, si) => {
    const color = SERIES_COLORS[si % SERIES_COLORS.length];
    const points = s.values.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
    canvas.push({ type: "polyline", lineWidth: 2, lineColor: color, lineJoin: "round", points });
    points.forEach((pt) => {
      // White halo + colored core makes each marker pop off the line.
      canvas.push({ type: "ellipse", x: pt.x, y: pt.y, r1: 3.4, r2: 3.4, color: C.blanco });
      canvas.push({ type: "ellipse", x: pt.x, y: pt.y, r1: 2.2, r2: 2.2, color });
    });
  });
  const catRow: Content = {
    columns: cats.map((c) => ({ width: PLOT_W / cats.length, text: sanitizeBrand(c), fontSize: 6.5, color: C.grisSuave, alignment: "center" })),
    margin: [PAD_LEFT, 2, 0, 0],
  };
  return {
    stack: [
      ...(block.title ? [{ text: sanitizeBrand(block.title), style: "chartTitle" } as Content] : []),
      { canvas },
      catRow,
      ...(multi ? [legend(seriesList.map((s) => s.name))] : []),
    ],
    unbreakable: true,
    margin: [0, 4, 0, 10],
  };
}

/** Entry point: turn a chart block into a pdfmake Content node. */
export function buildChart(block: PdfChartBlock): Content {
  if (block.type === "pie") return pie(block);
  if (block.type === "line") return line(block);
  // bar
  if (isMulti(block)) {
    return block.orientation === "h" ? barHorizontalMulti(block) : barMulti(block);
  }
  if (block.orientation === "h") return barHorizontal(block);
  return barVertical(block);
}
