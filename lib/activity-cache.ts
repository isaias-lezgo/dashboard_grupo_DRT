// lib/activity-cache.ts
// La parte PURA del caché de actividad de conversaciones: qué tipo de corrida
// toca (completa o incremental) y cómo se funde lo nuevo con lo guardado.
// Sin red ni base — verificado por scripts/verify-activity-cache.ts.
//
// El recorrido completo cuesta ~3.5 min (medido 2026-09-28) y roza el techo de
// Vercel. Una vez guardado, lo que cambia entre visitas es poco: solo las
// conversaciones con un mensaje posterior al último corte. Eso es lo que
// recorre la corrida incremental.

/** Un hilo que el presupuesto de tiempo no alcanzó a abrir. */
export interface PendingThread {
  conversationId: string;
  contactId: string;
}

export interface ActivityMeta {
  conversations: number;
  threadsOpened: number;
  /** Hilos que no abrieron: sus contactos caen en "+60 d" sin evidencia. */
  threadsFailed: number;
  /** Hilos que no se alcanzaron a abrir por el presupuesto de tiempo. */
  threadsUnopened: number;
  /** El recorrido se cortó antes del horizonte. */
  scanIncomplete: boolean;
  /** Hasta cuántos días atrás llegó el recorrido. */
  scannedDays: number;
  horizonDays: number;
  fetchedAt: string;
  mode: "full" | "incremental";
}

/** Lo que se guarda en Neon. `unopened` y `watermark` nunca viajan al navegador. */
export interface ActivityState {
  activity: Array<{ contactId: string; lastOutboundAt: string }>;
  meta: ActivityMeta & {
    /** El lastMessageDate más nuevo visto (epoch ms): hasta aquí ya se recorrió. */
    watermark: number | null;
    /** Cuándo terminó el último recorrido COMPLETO que llegó al horizonte. */
    fullAt: string | null;
    unopened: PendingThread[];
  };
}

/**
 * Cada cuánto se rehace el recorrido completo aunque el incremental funcione.
 * El incremental no ve dos derivas: una oportunidad que se reabre sin que su
 * conversación se mueva (su hilo se saltó por no tener abierta), y cualquier
 * hueco que dejara una página perdida. Un completo al día las corrige.
 */
export const FULL_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Traslape al empalmar con el corte anterior. El cursor es por valor de
 * lastMessageDate y GHL puede indexar con retraso; releer diez minutos es
 * barato y evita perder la conversación que llegó justo en el borde.
 */
export const WATERMARK_OVERLAP_MS = 10 * 60 * 1000;

export type RunPlan =
  | { mode: "full"; stopAt: number }
  | { mode: "incremental"; stopAt: number };

/**
 * ¿Completa o incremental? Incremental solo cuando la base es confiable: llegó
 * al horizonte, tiene corte, y su último completo es de hace menos de un día.
 * `stopAt` es el lastMessageDate donde el recorrido deja de paginar.
 */
export function planRun(
  base: ActivityState | null,
  now: number,
  horizonDays: number,
): RunPlan {
  const cutoff = now - horizonDays * 86_400_000;
  if (!base) return { mode: "full", stopAt: cutoff };
  const m = base.meta;
  const fullAt = m.fullAt ? Date.parse(m.fullAt) : NaN;
  if (
    m.scanIncomplete ||
    m.watermark === null ||
    m.horizonDays !== horizonDays ||
    Number.isNaN(fullAt) ||
    now - fullAt >= FULL_EVERY_MS
  ) {
    return { mode: "full", stopAt: cutoff };
  }
  return { mode: "incremental", stopAt: Math.max(cutoff, m.watermark - WATERMARK_OVERLAP_MS) };
}

/**
 * Funde fechas de último saliente. Por contacto gana la MÁS RECIENTE: el
 * último saliente solo avanza en el tiempo, así que una lectura vieja nunca
 * puede corregir hacia atrás a una nueva. Lo que quedó fuera del horizonte se
 * poda — ausente y "+60 d" significan lo mismo para la matriz, y así el caché
 * no acumula historia.
 */
export function mergeOutbound(
  base: Iterable<[string, string]>,
  updates: Iterable<[string, string]>,
  cutoff: number,
): Map<string, string> {
  const out = new Map<string, string>();
  const put = (contactId: string, iso: string) => {
    const t = Date.parse(iso);
    if (Number.isNaN(t) || t < cutoff) return;
    const prev = out.get(contactId);
    if (!prev || t > Date.parse(prev)) out.set(contactId, iso);
  };
  for (const [c, iso] of base) put(c, iso);
  for (const [c, iso] of updates) put(c, iso);
  return out;
}

/**
 * Hilos a abrir, sin repetir conversación: los recién vistos primero (son los
 * de actividad más reciente, los que más mueven la matriz) y luego los que el
 * presupuesto dejó pendientes en la corrida anterior.
 */
export function queueThreads(carried: PendingThread[], fresh: PendingThread[]): PendingThread[] {
  const seen = new Set<string>();
  const out: PendingThread[] = [];
  for (const t of [...fresh, ...carried]) {
    if (seen.has(t.conversationId)) continue;
    seen.add(t.conversationId);
    out.push(t);
  }
  return out;
}

/** Lo que sí viaja al navegador: el estado sin la contabilidad interna. */
export function toClientPayload(state: ActivityState) {
  const { watermark: _w, fullAt: _f, unopened: _u, ...meta } = state.meta;
  return { activity: state.activity, meta };
}
