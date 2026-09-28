// El eje de mensajes de "Oportunidades sin atención": por contacto, la fecha
// del último mensaje saliente. El cálculo vive en lib/conversation-activity.ts;
// esta ruta decide entre el caché y una corrida en vivo, igual que
// app/api/dashboard:
//
//   - HAY caché y no viene ?fresh=1 → un frame `data` y termina (~1 s). Si pasó
//     de 15 min, after() corre un refresco incremental DESPUÉS de responder.
//   - NO hay caché (o ?fresh=1, o Postgres no responde) → corrida en vivo con
//     frames `tick` de progreso, y se guarda al terminar.
//
// La base NO es una dependencia: todo fallo de Postgres cae a la corrida en
// vivo. Y NO se cachea la corrida parcial como si fuera buena en silencio: su
// parcialidad viaja en `meta` y la tarjeta la dice.
import { after } from "next/server";
import { computeActivity } from "@/lib/conversation-activity";
import { toClientPayload, type ActivityState } from "@/lib/activity-cache";
import { claimSlot, isStale, readSlot, releaseSlot, writeSlot } from "@/lib/sync-store";
import { isDbConfigured } from "@/lib/db";
import { requireClient, unauthorized } from "@/lib/session";
import type { ClientConfig } from "@/lib/clients";

export const runtime = "nodejs";
// Una corrida completa tarda ~3.5 min (medido 2026-09-28). Sin esto la función
// quedaba en el techo por defecto y se cortaba a media corrida. El refresco de
// after() corre dentro de esta misma invocación y hereda el techo.
export const maxDuration = 300;

const SLOT = "conversation-activity" as const;

function enc(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

export async function GET(request: Request) {
  // El cliente se resuelve en el scope del request: cookies() no está
  // disponible ni dentro del callback del stream ni dentro de after().
  const client = await requireClient();
  if (!client) return unauthorized();

  const forceFresh = new URL(request.url).searchParams.get("fresh") === "1";
  const cached = await readCache(client);

  if (cached && !forceFresh) {
    if (isStale(cached.syncedAt)) {
      after(() => refreshInBackground(client, cached.payload));
    }
    return ndjson(
      enc({ type: "data", ...toClientPayload(cached.payload), cached: true })
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(enc(obj)));
      try {
        // Con ?fresh=1 y caché, la base permite una corrida incremental.
        const state = await computeActivity(client, cached?.payload ?? null, send);
        send({ type: "data", ...toClientPayload(state), cached: false });
        await saveQuietly(client, state);
      } catch (err) {
        console.error("[conversation-activity] corrida en vivo falló:", err);
        send({ type: "error", message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });
  return ndjson(stream);
}

function ndjson(body: BodyInit): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

async function readCache(client: ClientConfig) {
  if (!isDbConfigured()) return null;
  try {
    return await readSlot<ActivityState>(client, SLOT);
  } catch (err) {
    console.error("[activity-cache] lectura falló, se corre en vivo:", err);
    return null;
  }
}

async function saveQuietly(client: ClientConfig, state: ActivityState) {
  if (!isDbConfigured()) return;
  try {
    await writeSlot(client, SLOT, state, state.meta.fetchedAt);
  } catch (err) {
    console.error("[activity-cache] escritura falló:", err);
  }
}

// Corre después de la respuesta: todo camino de falla termina en un log, y el
// candado se suelta pase lo que pase.
async function refreshInBackground(client: ClientConfig, base: ActivityState) {
  let claimed = false;
  try {
    claimed = await claimSlot(client, SLOT);
    if (!claimed) return;
    const state = await computeActivity(client, base);
    // writeSlot limpia el candado él solo.
    await writeSlot(client, SLOT, state, state.meta.fetchedAt);
    console.log(
      `[activity-cache] ${client.id} refrescado (${state.meta.mode}, ` +
        `${state.meta.conversations} conversaciones, ${state.meta.threadsOpened} hilos)`
    );
  } catch (err) {
    console.error(`[activity-cache] refresco falló para ${client.id}:`, err);
    if (claimed) {
      // El último caché bueno se queda: una matriz de hace una hora le gana a
      // ninguna matriz.
      await releaseSlot(client, SLOT, err instanceof Error ? err.message : String(err)).catch(
        () => {}
      );
    }
  }
}
