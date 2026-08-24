import { after } from "next/server";
import { requireClient, unauthorized } from "@/lib/session";
import { isDbConfigured } from "@/lib/db";
import { claimSync, isStale, readSync, releaseSync, writeSync } from "@/lib/sync-store";
import { syncProject } from "@/lib/sync";
import type { ClientConfig } from "@/lib/clients";
import type { DashboardPayload } from "@/lib/types";

export const runtime = "nodejs";

// Un sync frío de este panel tarda decenas de segundos y GHL varía casi al doble
// entre dos corridas sobre los mismos datos. 300 s deja margen para eso y para
// que la cuenta crezca.
//
// Requiere Fluid Compute encendido (Settings → Functions): eso es lo que sube el
// techo a 300 s, no el plan — Hobby con Fluid lo permite. Sin Fluid el techo es
// 60 s, y un refresco cortado a la mitad falla EN SILENCIO, porque corre después
// de que la respuesta ya salió. El síntoma es sutil: el "Actualizado hace X"
// deja de avanzar.
export const maxDuration = 300;

function enc(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

export async function GET(req: Request) {
  // El cliente se resuelve aquí, en el scope de la petición — cookies() no está
  // disponible ni dentro del callback del stream ni dentro de after().
  const client = await requireClient();
  if (!client) return unauthorized();

  const forceFresh = new URL(req.url).searchParams.get("fresh") === "1";

  // El caché es un acelerador, nunca una dependencia: cualquier falla de la base
  // se registra y cae al sync en vivo, exactamente como se comportaba la app
  // antes de que existiera.
  const cached = forceFresh ? null : await readCache(client);

  if (cached) {
    // Camino caliente: un solo frame, sin progreso, sin GHL. Este es el punto.
    const body = enc({ type: "data", ...cached.payload });
    if (isStale(cached.syncedAt)) {
      // after() corre una vez que la respuesta salió completa, así que el
      // usuario nunca espera esto. Sin after(), la función se destruye al
      // cerrarse la respuesta y el refresco simplemente nunca ocurre.
      after(() => refreshInBackground(client));
    }
    return ndjson(body);
  }

  // Camino frío (nunca sincronizado, ?fresh=1, o la base no responde): el stream
  // del sync en vivo con la pantalla de carga, igual que siempre, y guarda el
  // resultado.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // withClient se entra DENTRO de syncProject, no alrededor de GET(): el
      // stream sigue produciendo frames después de que GET() regresó.
      const send = (obj: unknown) => controller.enqueue(encoder.encode(enc(obj)));
      try {
        const payload = await syncProject(client, send);
        send({ type: "data", ...payload });
        await saveQuietly(client, payload);
      } catch (error) {
        console.error("[GHL Dashboard API Error]", error);
        send({
          type: "error",
          error: "Failed to fetch dashboard data",
          message: error instanceof Error ? error.message : "Unknown error",
        });
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
    return await readSync(client);
  } catch (err) {
    console.error("[cache] read failed, falling back to a live sync:", err);
    return null;
  }
}

// Una escritura de caché nunca debe romper una respuesta que el usuario ya tiene.
async function saveQuietly(client: ClientConfig, payload: DashboardPayload) {
  if (!isDbConfigured()) return;
  try {
    await writeSync(client, payload);
  } catch (err) {
    console.error("[cache] write failed:", err);
  }
}

// Corre después de la respuesta. Nada de aquí puede llegarle al usuario, así que
// todo camino de falla termina en un log — pero el candado DEBE soltarse pase lo
// que pase, o el cliente deja de refrescarse hasta que expire el timeout de 10
// minutos.
async function refreshInBackground(client: ClientConfig) {
  let claimed = false;
  try {
    claimed = await claimSync(client);
    // Alguien más ya está sincronizando: dos personas abriendo el mismo panel
    // viejo a la vez deben producir un sync, no dos.
    if (!claimed) return;
    const payload = await syncProject(client);
    // writeSync limpia sync_started_at él solo, así que el camino feliz no
    // necesita releaseSync.
    await writeSync(client, payload);
    console.log(`[cache] ${client.id} refrescado en segundo plano`);
  } catch (err) {
    console.error(`[cache] background refresh failed for ${client.id}:`, err);
    if (claimed) {
      // Suelta el candado SIN tocar el payload: el último caché bueno se queda,
      // porque un dashboard de hace una hora le gana a ningún dashboard.
      await releaseSync(client, err instanceof Error ? err.message : String(err)).catch(() => {});
    }
  }
}
