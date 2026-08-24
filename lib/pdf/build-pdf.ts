import type { TDocumentDefinitions, Content } from "pdfmake/interfaces";
import type { PdfSpec, PdfBlock } from "./types";
import { STYLES, PAGE_MARGINS, buildCover, header, footer, C } from "./branding";
import { buildBlock } from "./blocks";
import { triggerBlobDownload } from "@/lib/download";

export interface PdfResult {
  success: boolean;
  filename?: string;
  pages?: number;
  error?: string;
}

const VALID_T = new Set([
  "heading", "subheading", "text", "bullets", "kpis", "table", "callout", "chart",
]);

/** Validate the raw tool input into a PdfSpec. Returns null if unusable. */
export function parsePdfSpec(input: unknown): PdfSpec | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim() : null;
  if (!title) return null;
  if (!Array.isArray(o.blocks)) return null;

  const blocks: PdfBlock[] = [];
  for (const raw of o.blocks) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    if (typeof b.t !== "string" || !VALID_T.has(b.t)) continue;
    blocks.push(b as unknown as PdfBlock);
  }
  if (blocks.length === 0) return null;

  return {
    title,
    accent: typeof o.accent === "string" ? o.accent : undefined,
    client: typeof o.client === "string" ? o.client : undefined,
    subtitle: typeof o.subtitle === "string" ? o.subtitle : undefined,
    cover: o.cover === false ? false : true,
    filename: typeof o.filename === "string" && o.filename.trim() ? o.filename.trim() : undefined,
    blocks,
  };
}

// Strip characters that are illegal in filenames across Windows/macOS while
// keeping the name human-readable (spaces, accents, "·", "-" all survive).
function sanitizeFilename(s: string): string {
  return (
    s
      .replace(/[/\\?%*:|"<>]/g, ".") // ":" in "2:02pm" → "2.02pm", etc.
      .replace(/\s+/g, " ")
      .replace(/\.{2,}/g, ".")
      .trim()
      .slice(0, 120) || "reporte"
  );
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "reporte"
  );
}

export function buildDocDefinition(spec: PdfSpec): TDocumentDefinitions {
  const content: Content[] = [];
  if (spec.cover !== false) {
    content.push(...buildCover(spec));
  }
  for (const block of spec.blocks) {
    const node = buildBlock(block);
    if (node) content.push(node);
  }
  return {
    pageSize: "LETTER",
    // Landscape: the charts are the point of these reports, and a 712pt-wide
    // plot fits far more categories legibly than a portrait 532pt one.
    pageOrientation: "landscape",
    pageMargins: PAGE_MARGINS,
    defaultStyle: { fontSize: 10, color: C.grisMed },
    styles: STYLES,
    header: (currentPage: number) => header(currentPage) ?? "",
    footer: (currentPage: number, pageCount: number) => footer(currentPage, pageCount) ?? "",
    content,
  };
}

type Vfs = Record<string, string>;
// pdfmake 0.3.x: createPdf(...).getBlob() is an async method returning a
// Promise<Blob> (older 0.2.x took a callback). We use the promise form.
interface PdfDoc {
  getBlob: (() => Promise<Blob>) | ((cb: (b: Blob) => void) => void);
  // 0.3.x: resolves to the rendered pdfkit document, from which we read the
  // real page count (see getPageCount).
  getStream?: () => Promise<unknown>;
}
interface PdfMakeStatic {
  vfs?: Vfs;
  addVirtualFileSystem?: (vfs: Vfs) => void;
  createPdf: (d: TDocumentDefinitions) => PdfDoc;
}

// Resolve a Blob from either the promise-based (0.3.x) or callback-based (0.2.x)
// getBlob, so the code survives a pdfmake major bump in either direction.
function getBlob(doc: PdfDoc): Promise<Blob> {
  const ret = (doc.getBlob as (cb?: (b: Blob) => void) => unknown)();
  if (ret && typeof (ret as Promise<Blob>).then === "function") {
    return ret as Promise<Blob>;
  }
  return new Promise<Blob>((resolve) => {
    (doc.getBlob as (cb: (b: Blob) => void) => void)((b) => resolve(b));
  });
}

// Read the *real* rendered page count from pdfmake's underlying pdfkit document,
// not the number of spec blocks (one block can span many pages, or several
// blocks can share one). getStream() resolves to the pdfkit doc once all pages
// have been laid out. We read it two ways and fall back gracefully — a missing
// count must never break the download, so we return undefined on any failure.
async function getPageCount(doc: PdfDoc): Promise<number | undefined> {
  if (typeof doc.getStream !== "function") return undefined;
  try {
    const pdfDoc = (await doc.getStream()) as {
      bufferedPageRange?: () => { start: number; count: number };
      _root?: { data?: { Pages?: { data?: { Count?: number } } } };
    };
    const range = pdfDoc.bufferedPageRange?.();
    if (range && Number.isFinite(range.start + range.count)) {
      return range.start + range.count;
    }
    const count = pdfDoc._root?.data?.Pages?.data?.Count;
    return typeof count === "number" && count > 0 ? count : undefined;
  } catch {
    return undefined;
  }
}

// Pull a usable vfs font map out of whatever shape pdfmake's vfs_fonts module
// exports. 0.3.x does `module.exports = vfs` (a flat { "Roboto-Regular.ttf": … }
// map); older builds nest it under `pdfMake.vfs`. Handle all of them.
function extractVfs(mod: unknown): Vfs | undefined {
  const looksLikeVfs = (v: unknown): v is Vfs =>
    !!v && typeof v === "object" && "Roboto-Regular.ttf" in (v as Record<string, unknown>);

  const m = mod as Record<string, unknown> | undefined;
  if (!m) return undefined;
  const candidates: unknown[] = [
    (m.pdfMake as Record<string, unknown> | undefined)?.vfs,
    ((m.default as Record<string, unknown> | undefined)?.pdfMake as Record<string, unknown> | undefined)?.vfs,
    (m.default as Record<string, unknown> | undefined)?.vfs,
    m.vfs,
    m.default,
    m,
  ];
  for (const c of candidates) {
    if (looksLikeVfs(c)) return c;
  }
  return undefined;
}

// Lazy-load pdfmake + fonts only in the browser, on first use, to keep them out
// of the server bundle and the initial client chunk.
async function getPdfMake(): Promise<PdfMakeStatic> {
  const pdfMakeMod = await import("pdfmake/build/pdfmake");
  const pdfFontsMod = await import("pdfmake/build/vfs_fonts");
  const pdfMake = ((pdfMakeMod as { default?: unknown }).default ?? pdfMakeMod) as PdfMakeStatic;
  const vfs = extractVfs(pdfFontsMod);
  if (vfs) {
    if (typeof pdfMake.addVirtualFileSystem === "function") pdfMake.addVirtualFileSystem(vfs);
    else pdfMake.vfs = vfs;
  }
  return pdfMake;
}

/** Build the PDF from a raw tool input and trigger a browser download. */
export async function downloadPdf(input: unknown): Promise<PdfResult> {
  const spec = parsePdfSpec(input);
  if (!spec) return { success: false, error: "Spec inválido o sin bloques." };

  try {
    const docDef = buildDocDefinition(spec);
    const pdfMake = await getPdfMake();
    const filename = spec.filename
      ? `${sanitizeFilename(spec.filename)}.pdf`
      : `${slugify(spec.title)}.pdf`;
    const doc = pdfMake.createPdf(docDef);
    const blob = await getBlob(doc);
    const pages = await getPageCount(doc);
    triggerBlobDownload(blob, filename);
    return { success: true, filename, pages };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
