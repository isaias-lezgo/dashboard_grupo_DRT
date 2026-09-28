// Deriva, por contacto, la fecha del ÚLTIMO MENSAJE SALIENTE — el eje de
// mensajes de la matriz "Oportunidades sin atención".
//
// GHL no expone ese dato: /conversations/search trae lastMessageDate y
// lastMessageDirection, pero ninguna fecha de "último saliente"
// (lastManualMessageDate NO lo es: cuenta manuales en ambas direcciones). Se
// deriva con dos observaciones:
//
//   1. Si la conversación termina en SALIENTE, lastMessageDate ya es la fecha
//      buscada. Es el ~93 % de los casos y no cuesta una sola llamada extra.
//   2. El último saliente es siempre ≤ el último mensaje. Una conversación muda
//      por más de STALE_HORIZON_DAYS cae en la cubeta más profunda sin abrirla.
//
// Solo se abre el hilo del resto: termina en entrante Y está dentro del
// horizonte Y el contacto tiene una oportunidad ABIERTA (ver needsThread).
//
// Escala medida 2026-09-28: 60 días = ~7,700 conversaciones (78 páginas) y
// ~3,200 que no terminan en saliente — 64 % de ellas vacías (TYPE_NO_SHOW), la
// mayoría de la carga CSV de Palmyra/Zanda. Sin el filtro por oportunidad
// abierta eran ~13 min de hilos; con él ~740 hilos y ~2.5 min.
//
// Se carga en segundo plano como /api/dashboard-messages: fuera de la ruta
// crítica, el panel pinta primero.
import {
  getMessages,
  searchConversationsPage,
  type GHLConversationSearchDoc,
} from "@/lib/ghl-client";
import { isActivityMessage } from "@/lib/ghl-message-mapper";
import { STALE_HORIZON_DAYS } from "@/lib/stale-opportunity-matrix";
import { requireClient, unauthorized } from "@/lib/session";
import { withClient } from "@/lib/ghl-context";

function enc(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

export const runtime = "nodejs";
// El recorrido tarda ~85 s en condiciones limpias y bastante más cuando compite
// por el presupuesto de GHL con otro sync (429 → pausas de 10 s). Sin esto la
// función quedaba al techo por defecto y se cortaba a media corrida.
export const maxDuration = 300;

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
 * Presupuesto de pared, por debajo de maxDuration (300 s). Al agotarse se deja
 * de abrir hilos y se entrega lo que hay, marcado como incompleto: una lectura
 * parcial con nota vale más que una función cortada por Vercel sin respuesta.
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

export async function GET() {
  // El cliente se resuelve en el scope del request: cookies() no está
  // disponible dentro del callback del stream.
  const client = await requireClient();
  if (!client) return unauthorized();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // El contexto se entra AQUÍ, no alrededor de GET(): el stream sobrevive al
      // return del handler, así que envolver el handler dejaría la bomba
      // corriendo fuera del contexto.
      await withClient(client, async () => {
        const send = (obj: unknown) => {
          controller.enqueue(encoder.encode(enc(obj)));
        };

        try {
          const t0 = Date.now();
          const overBudget = () => Date.now() - t0 > TIME_BUDGET_MS;
          const cutoff = Date.now() - STALE_HORIZON_DAYS * 86_400_000;

          send({ type: "progress", message: "Cargando actividad de conversaciones…" });

          // Frames `tick`: el avance estructurado que pinta la barra de la
          // tarjeta. En la fase `scan` el total de conversaciones no se conoce
          // de antemano, pero el recorrido va de la más reciente hacia atrás, así
          // que qué tan lejos llegó dentro del horizonte ES el porcentaje.
          const horizonMs = STALE_HORIZON_DAYS * 86_400_000;
          send({ type: "tick", phase: "scan", scanned: 0, horizonPct: 0 });

          // 1. Recorrer las conversaciones de la más reciente a la más vieja y
          //    cortar al cruzar el horizonte.
          const outboundAt = new Map<string, string>(); // contactId → ISO
          const pending: Array<{ conversationId: string; contactId: string }> = [];
          const seenConvIds = new Set<string>();
          let cursor: number | string | undefined;
          let scanned = 0;
          let reachedHorizon = false;
          let scanIncomplete = false;
          let oldestTs = Date.now();

          for (let page = 0; page < MAX_PAGES && !reachedHorizon; page++) {
            if (overBudget()) {
              scanIncomplete = true;
              break;
            }
            let docs: GHLConversationSearchDoc[];
            try {
              const res = await searchConversationsPage({
                limit: PAGE_SIZE,
                startAfterDate: cursor,
              });
              docs = res.conversations;
            } catch (err) {
              // Se conserva lo que ya se recorrió, igual que cursorWalk: una
              // página perdida mueve algunos leads una cubeta, perderlo todo
              // haría que el gráfico acuse abandono total.
              console.error("[GHL] conversation-activity: página fallida:", err);
              // Sin una sola página no hay nada que conservar: emitir un mapa
              // vacío como "listo" mandaría a TODOS a "+60 d". Eso es un error.
              if (scanned === 0) throw err;
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
              scanned++;

              const lastIso = toIso(c.lastMessageDate);
              const ts = lastIso ? new Date(lastIso).getTime() : NaN;
              if (!Number.isNaN(ts)) oldestTs = Math.min(oldestTs, ts);
              if (!Number.isNaN(ts) && ts < cutoff) {
                reachedHorizon = true;
                continue;
              }
              if (!c.contactId) continue;

              if (c.lastMessageDirection === "outbound" && lastIso) {
                // Observación 1: termina en saliente ⇒ ya es la fecha buscada.
                const prev = outboundAt.get(c.contactId);
                if (!prev || new Date(lastIso) > new Date(prev)) {
                  outboundAt.set(c.contactId, lastIso);
                }
              } else if (needsThread(c)) {
                pending.push({ conversationId: c.id, contactId: c.contactId });
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
              scanned,
              horizonPct: Math.min(1, Math.max(0, (Date.now() - oldestTs) / horizonMs)),
            });
          }

          // 2. Abrir solo los hilos que terminan en entrante y siguen dentro del
          //    horizonte, con concurrencia acotada.
          send({ type: "tick", phase: "threads", scanned, done: 0, total: pending.length });

          let idx = 0;
          let done = 0;
          let threadsFailed = 0;
          let threadsUnopened = 0;
          const found: Array<{ contactId: string; iso: string } | null> = new Array(
            pending.length
          );
          await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
              while (idx < pending.length) {
                if (overBudget()) {
                  // Los que quedan se cuentan una sola vez, por el primer
                  // trabajador que ve el presupuesto agotado.
                  threadsUnopened += pending.length - idx;
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
                  found[i] = best ? { contactId, iso: best } : null;
                } catch {
                  // El hilo no abrió: se deja sin dato. El cliente lo lee como la
                  // cubeta más profunda, que es la lectura conservadora correcta
                  // (el último saliente es ≤ el último mensaje, que ya es viejo).
                  found[i] = null;
                  threadsFailed++;
                }
                done++;
                // Cada 5 hilos basta para que la barra se mueva sin inundar el
                // stream (600 hilos = 120 frames).
                if (done % 5 === 0 || done === pending.length) {
                  send({ type: "tick", phase: "threads", scanned, done, total: pending.length });
                }
              }
            })
          );

          for (const hit of found) {
            if (!hit) continue;
            const prev = outboundAt.get(hit.contactId);
            if (!prev || new Date(hit.iso) > new Date(prev)) {
              outboundAt.set(hit.contactId, hit.iso);
            }
          }

          // Solo se emiten los contactos CON dato. Todo lo demás —contacto sin
          // conversación, o conversación fuera del horizonte— el cliente lo
          // trata como null, que es la cubeta más profunda. Es correcto por la
          // observación 2, no una aproximación.
          const activity = [...outboundAt.entries()].map(([contactId, lastOutboundAt]) => ({
            contactId,
            lastOutboundAt,
          }));

          send({
            type: "data",
            activity,
            meta: {
              conversations: scanned,
              threadsOpened: pending.length,
              threadsFailed,
              threadsUnopened,
              // El recorrido se cortó antes del horizonte: los contactos cuya
              // conversación no se alcanzó caen en "+60 d" sin merecerlo.
              scanIncomplete,
              scannedDays: Math.round((Date.now() - oldestTs) / 86_400_000),
              horizonDays: STALE_HORIZON_DAYS,
              fetchedAt: new Date().toISOString(),
            },
          });
          controller.close();
        } catch (err) {
          send({ type: "error", message: (err as Error).message });
          controller.close();
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
