// lib/conversation-activity.ts — SERVER-ONLY (importa ghl-client).
//
// Deriva, por contacto, la fecha del ÚLTIMO MENSAJE SALIENTE — el eje de
// mensajes de la matriz "Oportunidades sin atención".
//
// GHL no expone ese dato: /conversations/search trae lastMessageDate y
// lastMessageDirection, pero ninguna fecha de "último saliente"
// (lastManualMessageDate NO lo es: cuenta manuales en ambas direcciones). Se
// deriva con dos observaciones:
//
//   1. Si la conversación termina en SALIENTE, lastMessageDate ya es la fecha
//      buscada, sin una sola llamada extra.
//   2. El último saliente es siempre ≤ el último mensaje. Una conversación muda
//      por más de STALE_HORIZON_DAYS cae en la cubeta más profunda sin abrirla.
//
// Solo se abre el hilo del resto: termina en entrante Y está dentro del
// horizonte Y el contacto tiene una oportunidad ABIERTA (ver needsThread).
//
// Escala medida 2026-09-28: 60 días = ~7,700 conversaciones (78 páginas) y
// ~3,200 que no terminan en saliente — 64 % de ellas vacías (TYPE_NO_SHOW), la
// mayoría de la carga CSV de Palmyra/Zanda. Sin el filtro por oportunidad
// abierta eran ~13 min de hilos; con él ~740 hilos y ~3.5 min. Por eso el
// resultado se guarda en Neon y las corridas siguientes son incrementales (ver
// lib/activity-cache.ts).
//
// Sale de la ruta por la misma razón que lib/sync.ts: la ruta y el refresco en
// segundo plano llaman a ESTE código; dos copias se desincronizan.
import {
  getMessages,
  searchConversationsPage,
  type GHLConversationSearchDoc,
} from "./ghl-client";
import { isActivityMessage } from "./ghl-message-mapper";
import { STALE_HORIZON_DAYS } from "./stale-opportunity-matrix";
import { withClient } from "./ghl-context";
import type { ClientConfig } from "./clients";
import {
  mergeOutbound,
  planRun,
  queueThreads,
  type ActivityState,
  type PendingThread,
} from "./activity-cache";

/**
 * Normaliza a ISO. GHL devuelve `lastMessageDate` como epoch en MILISEGUNDOS
 * (número), mientras que el `dateAdded` de los mensajes viene como ISO — y los
 * tipos de la API declaran string en ambos. Verificado contra la sub-cuenta
 * real: la búsqueda de conversaciones regresa 1786082787710, no una fecha.
 *
 * Se normaliza aquí, en la frontera, y no río abajo, porque el consumidor hace
 * `new Date(valor)`: con un número funciona de casualidad, pero si ese mismo
 * epoch llegara como CADENA ("1786082787710") daría Invalid Date, el cliente lo
 * leería como "sin dato" y mandaría a TODOS los contactos a la cubeta de
 * abandono. Ese fallo no se ve como un error, se ve como una acusación.
 */
function toIso(value: string | number | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  const d = Number.isFinite(n) ? new Date(n) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Páginas máximas del recorrido. 60 días eran 78 páginas el 2026-09-28; el
 * tope viejo (60) cortaba el recorrido en el día 32 sin avisar. Es un seguro,
 * no una estimación: el corte real es el horizonte o el presupuesto de tiempo.
 */
const MAX_PAGES = 250;
const PAGE_SIZE = 100;
/** = MAX_CONCURRENT_GHL_REQUESTS del limitador; más no corre más rápido. */
const CONCURRENCY = 8;
/**
 * Presupuesto de pared, por debajo del maxDuration de la ruta (300 s). Al
 * agotarse se deja de abrir hilos y se entrega lo que hay, marcado como
 * incompleto; los hilos sin abrir se guardan y la siguiente corrida los retoma.
 */
const TIME_BUDGET_MS = 250_000;

/**
 * ¿Vale la pena abrir este hilo? Solo si el contacto tiene una oportunidad
 * abierta: la matriz solo cuenta abiertas, así que el último saliente de un
 * contacto sin ninguna no cambia una sola celda. Si el documento no trae la
 * lista (~13 %), no se puede concluir nada y se abre.
 */
function needsThread(c: GHLConversationSearchDoc): boolean {
  if (!Array.isArray(c.opportunities)) return true;
  return c.opportunities.some((o) => o.status === "open");
}

/**
 * Una corrida: completa si no hay base confiable, incremental si la hay.
 * `send` recibe los frames `tick` de progreso; el refresco en segundo plano no
 * tiene a quién mandarlos y lo omite.
 *
 * Lanza solo cuando no hay NADA que entregar (la primera página falló). Una
 * corrida parcial regresa normalmente, con la parcialidad en `meta`.
 */
export async function computeActivity(
  client: ClientConfig,
  base: ActivityState | null,
  send: (obj: unknown) => void = () => {},
): Promise<ActivityState> {
  return withClient(client, async () => {
    const t0 = Date.now();
    const overBudget = () => Date.now() - t0 > TIME_BUDGET_MS;
    const cutoff = t0 - STALE_HORIZON_DAYS * 86_400_000;
    const plan = planRun(base, t0, STALE_HORIZON_DAYS);
    const span = Math.max(1, t0 - plan.stopAt);

    // Frames `tick`: el avance estructurado que pinta la barra de la tarjeta.
    // El total de conversaciones no se conoce de antemano, pero el recorrido va
    // de la más reciente hacia atrás, así que qué tan lejos llegó dentro del
    // tramo por recorrer ES el porcentaje.
    send({ type: "tick", phase: "scan", mode: plan.mode, scanned: 0, horizonPct: 0 });

    // 1. Recorrer de la más reciente a la más vieja y cortar en stopAt.
    const outbound = new Map<string, string>(); // contactId → ISO
    const fresh: PendingThread[] = [];
    const seenConvIds = new Set<string>();
    let cursor: number | string | undefined;
    let scanned = 0;
    let reachedStop = false;
    let scanIncomplete = false;
    let oldestTs = t0;
    let newestTs: number | null = null;

    for (let page = 0; page < MAX_PAGES && !reachedStop; page++) {
      if (overBudget()) {
        scanIncomplete = true;
        break;
      }
      let docs: GHLConversationSearchDoc[];
      try {
        const res = await searchConversationsPage({ limit: PAGE_SIZE, startAfterDate: cursor });
        docs = res.conversations;
      } catch (err) {
        console.error("[GHL] conversation-activity: página fallida:", err);
        // Sin una sola página no hay nada que conservar: emitir un mapa vacío
        // como "listo" mandaría a TODOS a "+60 d". Eso es un error.
        if (scanned === 0) throw err;
        // Se conserva lo recorrido: una página perdida mueve algunos leads una
        // cubeta; perderlo todo haría que el gráfico acuse abandono total.
        scanIncomplete = true;
        break;
      }

      if (docs.length === 0) break;

      for (const c of docs) {
        // El cursor es por VALOR de sort: dos conversaciones con el mismo
        // lastMessageDate al milisegundo pueden repetirse en el corte.
        if (seenConvIds.has(c.id)) continue;
        seenConvIds.add(c.id);
        if (c.deleted) continue;

        const lastIso = toIso(c.lastMessageDate);
        const ts = lastIso ? new Date(lastIso).getTime() : NaN;
        if (!Number.isNaN(ts)) {
          if (ts < plan.stopAt) {
            reachedStop = true;
            continue;
          }
          oldestTs = Math.min(oldestTs, ts);
          newestTs = newestTs === null ? ts : Math.max(newestTs, ts);
        }
        scanned++;
        if (!c.contactId) continue;

        if (c.lastMessageDirection === "outbound" && lastIso) {
          // Observación 1: termina en saliente ⇒ ya es la fecha buscada.
          const prev = outbound.get(c.contactId);
          if (!prev || new Date(lastIso) > new Date(prev)) outbound.set(c.contactId, lastIso);
        } else if (needsThread(c)) {
          fresh.push({ conversationId: c.id, contactId: c.contactId });
        }
      }

      const last = docs[docs.length - 1];
      const next = last?.sort?.[0];
      if (next === undefined) break;
      cursor = next;
      if (docs.length < PAGE_SIZE) break;
      if (page === MAX_PAGES - 1) scanIncomplete = true;

      send({
        type: "tick",
        phase: "scan",
        mode: plan.mode,
        scanned,
        horizonPct: Math.min(1, Math.max(0, (t0 - oldestTs) / span)),
      });
    }

    // 2. Abrir los hilos: los recién vistos y los que la corrida anterior dejó
    //    pendientes (solo en incremental — una completa los vuelve a ver).
    const pending = queueThreads(plan.mode === "incremental" ? (base?.meta.unopened ?? []) : [], fresh);
    send({ type: "tick", phase: "threads", mode: plan.mode, scanned, done: 0, total: pending.length });

    let idx = 0;
    let done = 0;
    const failed: PendingThread[] = [];
    let unopenedFrom = pending.length;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
        while (idx < pending.length) {
          if (overBudget()) {
            unopenedFrom = Math.min(unopenedFrom, idx);
            idx = pending.length;
            break;
          }
          const i = idx++;
          const { conversationId, contactId } = pending[i];
          try {
            const res = await getMessages(conversationId, { limit: 50 });
            let best: string | null = null;
            for (const m of res.messages.messages) {
              if (m.direction !== "outbound") continue;
              // Un chip de "oportunidad creada" no es un mensaje a nadie.
              if (isActivityMessage(m)) continue;
              const iso = toIso(m.dateAdded);
              if (!iso) continue;
              if (!best || new Date(iso) > new Date(best)) best = iso;
            }
            if (best) {
              const prev = outbound.get(contactId);
              if (!prev || new Date(best) > new Date(prev)) outbound.set(contactId, best);
            }
          } catch {
            // El hilo no abrió: se deja sin dato. El cliente lo lee como la
            // cubeta más profunda, que es la lectura conservadora (el último
            // saliente es ≤ el último mensaje). Se reintenta en la siguiente.
            failed.push(pending[i]);
          }
          done++;
          // Cada 5 hilos basta para que la barra se mueva sin inundar el stream.
          if (done % 5 === 0 || done === pending.length) {
            send({ type: "tick", phase: "threads", mode: plan.mode, scanned, done, total: pending.length });
          }
        }
      })
    );
    // Lo que el presupuesto no alcanzó más lo que falló: la siguiente corrida
    // incremental lo retoma antes de darlo por perdido.
    const skipped = pending.slice(unopenedFrom);
    const unopened = [...skipped, ...failed];

    // 3. Fundir con la base SIEMPRE, también en una completa, y podar lo que
    //    salió del horizonte. Es seguro porque el último saliente solo avanza:
    //    una fecha guardada es una cota inferior real (salió de un mensaje que
    //    se vio). Y así una completa que el presupuesto corta a medio camino no
    //    manda a "+60 d" a los contactos cuyos hilos no alcanzó a reabrir.
    const merged = mergeOutbound(
      (base?.activity ?? []).map((a) => [a.contactId, a.lastOutboundAt] as [string, string]),
      outbound,
      cutoff
    );

    const fetchedAt = new Date().toISOString();
    // Un incremental que se corta a medio recorrido deja un hueco entre lo que
    // alcanzó y el corte anterior, que el siguiente incremental no vería: se
    // marca incompleto y el siguiente es completo.
    const fullAt =
      plan.mode === "full"
        ? scanIncomplete
          ? null
          : new Date(t0).toISOString()
        : (base?.meta.fullAt ?? null);

    return {
      // Solo contactos CON dato. Todo lo demás —sin conversación, o fuera del
      // horizonte— el cliente lo trata como null, la cubeta más profunda. Es
      // correcto por la observación 2, no una aproximación.
      activity: [...merged.entries()].map(([contactId, lastOutboundAt]) => ({
        contactId,
        lastOutboundAt,
      })),
      meta: {
        conversations: scanned,
        threadsOpened: done - failed.length,
        threadsFailed: failed.length,
        threadsUnopened: skipped.length,
        scanIncomplete,
        scannedDays: scanIncomplete
          ? Math.round((t0 - oldestTs) / 86_400_000)
          : STALE_HORIZON_DAYS,
        horizonDays: STALE_HORIZON_DAYS,
        fetchedAt,
        mode: plan.mode,
        watermark: newestTs ?? base?.meta.watermark ?? null,
        fullAt,
        unopened,
      },
    };
  });
}
