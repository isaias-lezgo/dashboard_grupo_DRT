// Document spec the AI emits via the create_pdf tool. Compact by design:
// the AI sends only content; lib/pdf/* applies all Lezgo branding.

export type CalloutStyle = "info" | "warn" | "ok" | "error";

/** Simple single-series point (same shape the AI already uses in render_chart). */
export interface SimpleSeriesPoint {
  label: string;
  value: number;
}

/** One series of a multi-series chart (stacked/grouped bar, multi-line). */
export interface MultiSeries {
  name: string;
  values: number[];
}

export interface PdfChartBlock {
  t: "chart";
  type: "bar" | "pie" | "line";
  title?: string;
  /** Tooltip/axis label, e.g. "Leads" or "Valor (MXN)". */
  valueLabel?: string;
  /** Bar only: "h" = horizontal. Default vertical. */
  orientation?: "h" | "v";
  /** Bar/line multi-series only: stack segments. Default grouped (side-by-side). */
  stacked?: boolean;
  /**
   * Present => multi-series form. X-axis category labels; each MultiSeries.values
   * is aligned to this array by index.
   */
  categories?: string[];
  /**
   * Simple form: SimpleSeriesPoint[]. Multi-series form: MultiSeries[] (when
   * `categories` is present). Discriminated at runtime by `categories`.
   */
  series: SimpleSeriesPoint[] | MultiSeries[];
}

export type PdfBlock =
  | { t: "heading"; text: string }
  | { t: "subheading"; text: string }
  | { t: "text"; text: string }
  | { t: "bullets"; items: string[] }
  | { t: "kpis"; items: { label: string; value: string }[] }
  | { t: "table"; headers: string[]; rows: string[][] }
  | { t: "callout"; style: CalloutStyle; text: string }
  | PdfChartBlock;

export interface PdfSpec {
  title: string;
  /** Orange accent line on the cover (optional 3rd title line). */
  accent?: string;
  /** Client name shown in the orange cover box. */
  client?: string;
  /** Short cover description paragraph. */
  subtitle?: string;
  /** Render a cover page. Default true. */
  cover?: boolean;
  /** Download filename (without extension). Falls back to a slug of `title`. */
  filename?: string;
  blocks: PdfBlock[];
}
